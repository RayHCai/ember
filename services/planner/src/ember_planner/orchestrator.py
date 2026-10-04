"""Watches the Redis job queue, gathers each job's watch-zone context from the api, hands it to a
Celery worker and delivers the worker's result back to the api.

The loop is single-threaded and owns every in-flight job, so no state is shared. A job stays in the
processing list until it is delivered or reported failed, and a restart puts any left there back on
the queue; this assumes one orchestrator per Redis.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from .wire import (
    PLANNER_CELERY_QUEUE,
    PLANNER_CELERY_TASK,
    PLANNER_CONTEXT_PATH,
    PLANNER_PROCESSING_KEY,
    PLANNER_QUEUE_KEY,
    PLANNER_RESULT_PATH,
    PLANNER_STATUS_PATH,
    JobState,
    Json,
    PlannerContext,
    PlannerJobRequest,
    PlannerJobStatusUpdate,
    PlannerResult,
)

log = logging.getLogger("ember_planner.orchestrator")

IDLE_POLL_S = 0.25
MAX_DELIVERY_ATTEMPTS = 5


class JobQueue(Protocol):
    def recover(self) -> int: ...
    def next(self, timeout_s: float) -> str | None: ...
    def ack(self, raw: str) -> None: ...


class TaskHandle(Protocol):
    @property
    def id(self) -> str: ...
    def ready(self) -> bool: ...
    def result(self) -> object: ...
    def cancel(self) -> None: ...


class Dispatcher(Protocol):
    def submit(self, job: Json, context: Json) -> TaskHandle: ...


class PlannerApi(Protocol):
    def context(self, zone_id: str) -> object: ...
    def status(self, update: PlannerJobStatusUpdate) -> None: ...
    def result(self, job_id: str, result: Json) -> None: ...


class RedisJobQueue:
    def __init__(self, redis: Any) -> None:
        self._redis = redis

    def recover(self) -> int:
        moved = 0
        while self._redis.lmove(PLANNER_PROCESSING_KEY, PLANNER_QUEUE_KEY, "LEFT", "RIGHT"):
            moved += 1
        return moved

    def next(self, timeout_s: float) -> str | None:
        raw = self._redis.blmove(
            PLANNER_QUEUE_KEY, PLANNER_PROCESSING_KEY, timeout_s, "RIGHT", "LEFT"
        )
        return None if raw is None else str(raw)

    def ack(self, raw: str) -> None:
        self._redis.lrem(PLANNER_PROCESSING_KEY, 1, raw)


class HttpPlannerApi:
    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    @staticmethod
    def connect(base_url: str, key: str, timeout_s: float = 10.0) -> HttpPlannerApi:
        return HttpPlannerApi(
            httpx.Client(
                base_url=base_url,
                headers={"Authorization": f"Bearer {key}"},
                timeout=timeout_s,
            )
        )

    def close(self) -> None:
        self._client.close()

    def context(self, zone_id: str) -> object:
        res = self._client.get(PLANNER_CONTEXT_PATH.replace(":zoneId", quote(zone_id, safe="")))
        res.raise_for_status()
        return res.json()

    def status(self, update: PlannerJobStatusUpdate) -> None:
        path = PLANNER_STATUS_PATH.replace(":jobId", quote(update.job_id, safe=""))
        self._client.post(path, json=update.to_json()).raise_for_status()

    def result(self, job_id: str, result: Json) -> None:
        path = PLANNER_RESULT_PATH.replace(":jobId", quote(job_id, safe=""))
        self._client.post(path, json=result).raise_for_status()


class CeleryHandle:
    def __init__(self, async_result: Any) -> None:
        self._r = async_result

    @property
    def id(self) -> str:
        return str(self._r.id)

    def ready(self) -> bool:
        return bool(self._r.ready())

    def result(self) -> object:
        try:
            return self._r.get(timeout=0, propagate=True)
        finally:
            self._r.forget()

    def cancel(self) -> None:
        self._r.revoke()


class CeleryDispatcher:
    def __init__(self, app: Any) -> None:
        self._app = app

    def submit(self, job: Json, context: Json) -> TaskHandle:
        return CeleryHandle(
            self._app.send_task(
                PLANNER_CELERY_TASK, args=[job, context], queue=PLANNER_CELERY_QUEUE
            )
        )


@dataclass
class InFlight:
    raw: str
    job: PlannerJobRequest
    handle: TaskHandle
    started: float
    result: Json | None = None
    attempts: int = 0
    retry_at: float = 0.0


class Orchestrator:
    def __init__(
        self,
        queue: JobQueue,
        api: PlannerApi,
        dispatcher: Dispatcher,
        *,
        max_in_flight: int,
        job_timeout_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.queue = queue
        self.api = api
        self.dispatcher = dispatcher
        self.max_in_flight = max_in_flight
        self.job_timeout_s = job_timeout_s
        self.clock = clock
        self.in_flight: dict[str, InFlight] = {}

    def run(self, stop: threading.Event, wait_s: float = 1.0) -> None:
        recovered = self.queue.recover()
        if recovered:
            log.info("requeued %d jobs left in processing", recovered)
        while not stop.is_set():
            if not self.step(wait_s):
                stop.wait(IDLE_POLL_S)

    def step(self, wait_s: float) -> bool:
        """Collects finished work, then takes at most one new job. False when at capacity."""
        self._collect()
        if len(self.in_flight) >= self.max_in_flight:
            return False
        raw = self.queue.next(min(wait_s, IDLE_POLL_S) if self.in_flight else wait_s)
        if raw is not None:
            self._start(raw)
        return True

    def _start(self, raw: str) -> None:
        try:
            job = PlannerJobRequest.model_validate_json(raw)
        except ValidationError as e:
            self._reject(raw, e)
            return
        if job.job_id in self.in_flight:
            log.warning("job %s: already in flight, dropping the duplicate", job.job_id)
            self.queue.ack(raw)
            return

        self._status(job, "gathering", None)
        try:
            ctx = PlannerContext.model_validate(self.api.context(job.zone_id))
        except (httpx.HTTPError, ValidationError, ValueError) as e:
            self._fail(raw, job, f"zone {job.zone_id}: context: {e}")
            return
        if ctx.zone_id != job.zone_id:
            self._fail(raw, job, f"zone {job.zone_id}: api returned context for {ctx.zone_id}")
            return
        try:
            handle = self.dispatcher.submit(job.to_json(), ctx.to_json())
        except Exception as e:
            self._fail(raw, job, f"dispatch: {e}")
            return
        self.in_flight[job.job_id] = InFlight(raw, job, handle, self.clock())
        self._status(job, "planning", f"task {handle.id}")

    def _collect(self) -> None:
        for f in list(self.in_flight.values()):
            if f.result is None:
                if f.handle.ready():
                    try:
                        f.result = PlannerResult.model_validate(f.handle.result()).to_json()
                    except Exception as e:
                        self._fail(f.raw, f.job, f"worker: {e}")
                        continue
                elif self.clock() - f.started > self.job_timeout_s:
                    f.handle.cancel()
                    self._fail(f.raw, f.job, f"timed out after {self.job_timeout_s:g} s")
                    continue
                else:
                    continue
            if self.clock() >= f.retry_at:
                self._deliver(f, f.result)

    def _deliver(self, f: InFlight, result: Json) -> None:
        try:
            self.api.result(f.job.job_id, result)
        except httpx.HTTPStatusError as e:
            if e.response.status_code < 500:
                self._fail(f.raw, f.job, f"api rejected the result: {e.response.text[:200]}")
                return
            self._retry(f, e)
            return
        except httpx.HTTPError as e:
            self._retry(f, e)
            return
        log.info("job %s: result delivered", f.job.job_id)
        self._done(f.raw, f.job.job_id)

    def _retry(self, f: InFlight, err: Exception) -> None:
        f.attempts += 1
        if f.attempts >= MAX_DELIVERY_ATTEMPTS:
            self._fail(f.raw, f.job, f"result delivery failed {f.attempts} times: {err}")
            return
        log.warning("job %s: result delivery failed (%s), retrying", f.job.job_id, err)
        f.retry_at = self.clock() + 2.0**f.attempts

    def _fail(self, raw: str, job: PlannerJobRequest, message: str) -> None:
        log.error("job %s: %s", job.job_id, message)
        self._status(job, "failed", message)
        self._done(raw, job.job_id)

    def _reject(self, raw: str, err: ValidationError) -> None:
        log.error("dropping malformed job: %s", err)
        try:
            msg = json.loads(raw)
        except ValueError:
            msg = None
        if isinstance(msg, dict) and isinstance(msg.get("jobId"), str):
            self._send_status(
                PlannerJobStatusUpdate(
                    job_id=msg["jobId"],
                    zone_id=str(msg.get("zoneId", "")),
                    state="failed",
                    at=datetime.now(UTC),
                    message=f"malformed job: {err}"[:1000],
                )
            )
        self.queue.ack(raw)

    def _done(self, raw: str, job_id: str) -> None:
        self.queue.ack(raw)
        self.in_flight.pop(job_id, None)

    def _status(self, job: PlannerJobRequest, state: JobState, message: str | None) -> None:
        self._send_status(
            PlannerJobStatusUpdate(
                job_id=job.job_id,
                zone_id=job.zone_id,
                state=state,
                at=datetime.now(UTC),
                message=None if message is None else message[:1000],
            )
        )

    def _send_status(self, update: PlannerJobStatusUpdate) -> None:
        try:
            self.api.status(update)
        except httpx.HTTPError as e:
            log.warning("job %s: status %s not delivered: %s", update.job_id, update.state, e)
