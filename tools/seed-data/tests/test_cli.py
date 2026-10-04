import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from ember_seed_data.cli import main


class FakeApi:
    def __init__(
        self, zones: list[dict[str, Any]] | None = None, known: dict[str, str] | None = None
    ):
        self.zones = zones or []
        self.civilians: dict[str, str] = known or {}
        self.responders: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str]] = []
        self.auth: set[str | None] = set()
        self.edge_posts = 0
        self.phones: dict[str, str] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.calls.append((method, path))
        self.auth.add(request.headers.get("authorization"))
        body = json.loads(request.content) if request.content else None
        if (method, path) == ("GET", "/v1/watch-zones"):
            return httpx.Response(200, json=self.zones)
        if (method, path) == ("POST", "/v1/watch-zones"):
            zone = {"id": "zone-1", **body}
            self.zones.append(zone)
            return httpx.Response(201, json=zone)
        if method == "PUT" and path.endswith("/geography"):
            return httpx.Response(200, json=body)
        if path.endswith("/edge-servers"):
            self.edge_posts += 1
            return httpx.Response(409 if self.edge_posts > 3 else 201, json={})
        if path.endswith("/responders"):
            if method == "GET":
                return httpx.Response(200, json=self.responders)
            self.responders.append(body)
            return httpx.Response(201, json=body)
        if (method, path) == ("POST", "/civilians"):
            if body["email"] in self.civilians:
                return httpx.Response(409, json={})
            self.civilians[body["email"]] = f"c-{len(self.civilians)}"
            return httpx.Response(201, json={"id": self.civilians[body["email"]]})
        if (method, path) == ("GET", "/v1/civilians"):
            email = request.url.params["email"]
            return httpx.Response(200, json=[{"id": self.civilians[email]}])
        if method == "PATCH" and path.startswith("/v1/civilians/"):
            assert set(body) - {"phone"} == {"civilianAreaId", "location", "notes"}
            if "phone" in body:
                self.phones[path.rsplit("/", 1)[1]] = body["phone"]
            return httpx.Response(200, json={})
        return httpx.Response(500, text="unexpected")


def run(api: FakeApi, *extra: str) -> int:
    return main(
        ["lahaina", "--api", "http://api.test", "--key", "k", *extra], httpx.MockTransport(api)
    )


def test_fresh_run_creates_everything(capsys: pytest.CaptureFixture[str]) -> None:
    api = FakeApi()
    assert run(api) == 0
    assert ("POST", "/v1/watch-zones") in api.calls
    assert len(api.responders) == 6 and len(api.civilians) == 8
    assert api.auth == {"Bearer k"}
    assert "zone zone-1" in capsys.readouterr().out


def test_rerun_is_idempotent() -> None:
    api = FakeApi()
    run(api)
    api.calls.clear()
    assert run(api) == 0
    assert ("POST", "/v1/watch-zones") not in api.calls
    assert len(api.responders) == 6
    assert api.calls.count(("GET", "/v1/civilians")) == 8
    assert api.calls.count(("PATCH", "/v1/civilians/c-0")) == 1


def test_unexpected_status_names_route(capsys: pytest.CaptureFixture[str]) -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    code = main(["lahaina", "--api", "http://api.test"], httpx.MockTransport(broken))
    assert code == 1
    err = capsys.readouterr().err
    assert "GET /v1/watch-zones" in err and "500" in err


def test_out_writes_camel_case_json(tmp_path: Path) -> None:
    out = tmp_path / "lahaina.json"
    assert main(["lahaina", "--out", str(out)]) == 0
    data = json.loads(out.read_text())
    assert data["zone"]["name"] == "Lahaina"
    assert "civilianAreas" in data["geography"] and data["geography"]["terrain"] is None
    assert data["edgeServers"][0]["connectivityRadiusM"] == 1500
    assert data["civilians"][0]["zipCode"] == "96761"


def test_phone_goes_to_the_chosen_civilian_only() -> None:
    api = FakeApi()
    assert run(api, "--phone", "+18085550123") == 0
    assert api.phones == {"c-3": "+18085550123"}
    other = FakeApi()
    assert run(other, "--phone", "+18085550123", "--phone-civilian", "2") == 0
    assert other.phones == {"c-1": "+18085550123"}
