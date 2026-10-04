import json
import urllib.request
from typing import Any

import httpx
import pytest
from conftest import Scenario, build_context, job
from ember_planner.health import serve_health
from ember_planner.orchestrator import (
    MAX_DELIVERY_ATTEMPTS,
    HttpPlannerApi,
    Orchestrator,
)
from ember_planner.plan import run_plan
from ember_planner.wire import Json, PlannerJobStatusUpdate


class FakeQueue:
    def __init__(self, *raws: str) -> None:
        self.pending = list(raws)
        self.processing: list[str] = []

    def recover(self) -> int:
        n = len(self.processing)
        self.pending[:0] = self.processing
        self.processing.clear()
        return n

    def next(self, timeout_s: float) -> str | None:
        if not self.pending:
            return None
        raw = self.pending.pop(0)
        self.processing.append(raw)
        return raw

    def ack(self, raw: str) -> None:
        self.processing.remove(raw)


class FakeHandle:
    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome
        self.done = False
        self.cancelled = False

    @property
    def id(self) -> str:
        return "task-1"

    def ready(self) -> bool:
        return self.done

    def result(self) -> object:
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    def cancel(self) -> None:
        self.cancelled = True


class FakeDispatcher:
    """Runs the real planner at submit time; the handle turns ready when the test says so."""

    def __init__(self, fail: Exception | None = None) -> None:
        self.fail = fail
        self.handles: list[FakeHandle] = []

    def submit(self, job: Json, context: Json) -> FakeHandle:
        handle = FakeHandle(self.fail or run_plan(job, context))
        self.handles.append(handle)
        return handle


class FakeApi:
    def __init__(self, context: object = None, result_errors: list[Exception] | None = None):
        self.ctx = context
        self.result_errors = result_errors or []
        self.statuses: list[PlannerJobStatusUpdate] = []
        self.results: list[Json] = []

    def context(self, zone_id: str) -> object:
        if isinstance(self.ctx, Exception):
            raise self.ctx
        return self.ctx

    def status(self, update: PlannerJobStatusUpdate) -> None:
        self.statuses.append(update)

    def result(self, job_id: str, result: Json) -> None:
        if self.result_errors:
            raise self.result_errors.pop(0)
        self.results.append(result)

    def states(self) -> list[str]:
        return [s.state for s in self.statuses]


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def orchestrator(
    queue: FakeQueue, api: FakeApi, dispatcher: FakeDispatcher, clock: Clock | None = None
) -> Orchestrator:
    return Orchestrator(
        queue, api, dispatcher, max_in_flight=2, job_timeout_s=60, clock=clock or Clock()
    )


def raw_job(**overrides: Any) -> str:
    return json.dumps({**job(), **overrides})


def test_job_flows_from_queue_to_worker_to_api(scenario: Scenario) -> None:
    queue, api, dispatcher = FakeQueue(raw_job()), FakeApi(scenario()), FakeDispatcher()
    orch = orchestrator(queue, api, dispatcher)
    orch.step(0)
    assert api.states() == ["gathering", "planning"]
    assert queue.processing and not api.results

    dispatcher.handles[0].done = True
    orch.step(0)
    assert api.results[0]["jobId"] == "job-1" and "fireSpread" in api.results[0]
    assert not queue.processing and not orch.in_flight


def test_context_failure_reports_failed_and_drops_job() -> None:
    request = httpx.Request("GET", "http://api/x")
    err = httpx.HTTPStatusError(
        "404", request=request, response=httpx.Response(404, request=request)
    )
    queue, api = FakeQueue(raw_job()), FakeApi(err)
    orchestrator(queue, api, FakeDispatcher()).step(0)
    assert api.states() == ["gathering", "failed"]
    assert "context" in (api.statuses[-1].message or "")
    assert not queue.processing


def test_context_for_wrong_zone_fails(scenario: Scenario) -> None:
    queue, api = FakeQueue(raw_job()), FakeApi(scenario(zoneId="zone-9"))
    orchestrator(queue, api, FakeDispatcher()).step(0)
    assert api.states()[-1] == "failed"


def test_worker_error_reports_failed(scenario: Scenario) -> None:
    queue, api = FakeQueue(raw_job()), FakeApi(scenario())
    dispatcher = FakeDispatcher(fail=RuntimeError("boom"))
    orch = orchestrator(queue, api, dispatcher)
    orch.step(0)
    dispatcher.handles[0].done = True
    orch.step(0)
    assert api.states()[-1] == "failed" and "boom" in (api.statuses[-1].message or "")
    assert not queue.processing and not api.results


def test_slow_worker_times_out_and_is_cancelled(scenario: Scenario) -> None:
    clock = Clock()
    queue, api, dispatcher = FakeQueue(raw_job()), FakeApi(scenario()), FakeDispatcher()
    orch = orchestrator(queue, api, dispatcher, clock)
    orch.step(0)
    clock.t = 61
    orch.step(0)
    assert dispatcher.handles[0].cancelled
    assert api.states()[-1] == "failed" and "timed out" in (api.statuses[-1].message or "")


def test_result_delivery_is_retried_then_given_up(scenario: Scenario) -> None:
    clock = Clock()
    errors: list[Exception] = [httpx.ConnectError("down")] * MAX_DELIVERY_ATTEMPTS
    queue, api, dispatcher = FakeQueue(raw_job()), FakeApi(scenario(), errors), FakeDispatcher()
    orch = orchestrator(queue, api, dispatcher, clock)
    orch.step(0)
    dispatcher.handles[0].done = True
    orch.step(0)
    assert orch.in_flight and api.states()[-1] == "planning"
    for _ in range(MAX_DELIVERY_ATTEMPTS):
        clock.t += 100
        orch.step(0)
    assert api.states()[-1] == "failed" and not orch.in_flight and not queue.processing


def test_result_delivered_after_a_transient_error(scenario: Scenario) -> None:
    clock = Clock()
    queue = FakeQueue(raw_job())
    api, dispatcher = FakeApi(scenario(), [httpx.ConnectError("blip")]), FakeDispatcher()
    orch = orchestrator(queue, api, dispatcher, clock)
    orch.step(0)
    dispatcher.handles[0].done = True
    orch.step(0)
    clock.t += 100
    orch.step(0)
    assert len(api.results) == 1 and not queue.processing


def test_malformed_job_is_dropped_and_reported_when_it_has_an_id() -> None:
    queue, api = FakeQueue("not json", json.dumps({"jobId": "j9"})), FakeApi()
    orch = orchestrator(queue, api, FakeDispatcher())
    orch.step(0)
    orch.step(0)
    assert [(s.job_id, s.state) for s in api.statuses] == [("j9", "failed")]
    assert not queue.processing


def test_capacity_limits_jobs_in_flight(scenario: Scenario) -> None:
    queue = FakeQueue(*(raw_job(jobId=f"j{i}") for i in range(3)))
    orch = orchestrator(queue, FakeApi(scenario()), FakeDispatcher())
    assert orch.step(0) and orch.step(0)
    assert not orch.step(0)
    assert len(orch.in_flight) == 2 and len(queue.pending) == 1


def test_http_api_uses_contract_paths_and_auth(scenario: Scenario) -> None:
    seen: list[tuple[str, str, str | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, req.headers.get("authorization")))
        if req.method == "GET":
            return httpx.Response(200, json=build_context())
        return httpx.Response(202)

    api = HttpPlannerApi(
        httpx.Client(
            base_url="http://api",
            headers={"Authorization": "Bearer k"},
            transport=httpx.MockTransport(handler),
        )
    )
    queue, dispatcher = FakeQueue(raw_job(zoneId="zone-1")), FakeDispatcher()
    orch = orchestrator(queue, api, dispatcher)  # type: ignore[arg-type]
    orch.step(0)
    dispatcher.handles[0].done = True
    orch.step(0)
    assert [(m, p) for m, p, _ in seen] == [
        ("POST", "/v1/planner/jobs/job-1/status"),
        ("GET", "/v1/watch-zones/zone-1/planner-context"),
        ("POST", "/v1/planner/jobs/job-1/status"),
        ("POST", "/v1/planner/jobs/job-1/result"),
    ]
    assert {auth for _, _, auth in seen} == {"Bearer k"}


def test_api_rejecting_result_fails_the_job(scenario: Scenario) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json=build_context())
        if req.url.path.endswith("/result"):
            return httpx.Response(400, json={"error": "bad shape"})
        return httpx.Response(202)

    api = HttpPlannerApi(
        httpx.Client(base_url="http://api", transport=httpx.MockTransport(handler))
    )
    queue, dispatcher = FakeQueue(raw_job()), FakeDispatcher()
    orch = orchestrator(queue, api, dispatcher)  # type: ignore[arg-type]
    orch.step(0)
    dispatcher.handles[0].done = True
    orch.step(0)
    assert not orch.in_flight and not queue.processing


@pytest.mark.parametrize("path, code", [("/healthz", 200), ("/nope", 404)])
def test_health_endpoint(path: str, code: int) -> None:
    server = serve_health("planner-orchestrator", 0, lambda: {"inFlight": 3}, host="127.0.0.1")
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}{path}"
        try:
            with urllib.request.urlopen(url, timeout=5) as res:
                status, body = res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            status, body = e.code, None
        assert status == code
        if body is not None:
            assert body == {"service": "planner-orchestrator", "ok": True, "inFlight": 3}
    finally:
        server.shutdown()
