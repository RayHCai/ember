import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import zones as zones_api
from app.geo import osm
from app.main import create_app
from app.runtime import Runtime

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "overpass_small.json").read_text())
ZONE = [[34.19, -118.09], [34.19, -118.03], [34.225, -118.03], [34.225, -118.09]]


@pytest.fixture
def client(monkeypatch):
    def fake_load(polygon):
        return osm.OsmData(*osm.parse(FIXTURE, polygon), source="osm")

    monkeypatch.setattr(zones_api, "load_osm", fake_load)
    runtime = Runtime(speed=1)
    with TestClient(create_app(runtime)) as c:
        c.runtime = runtime
        yield c


def kinds(runtime: Runtime) -> list[str]:
    return [e["kind"] for e in runtime.state.log] + list(runtime.state.zone_maps and ["zone_map"])


def test_create_zone_emits_zone_and_map(client) -> None:
    res = client.post("/zones", json={"name": "Ridge watch", "polygon": ZONE})
    assert res.status_code == 201
    zone = res.json()
    assert zone["name"] == "Ridge watch"
    assert zone["area_km2"] == pytest.approx(21.5, rel=0.05)

    state = client.runtime.state
    assert zone["id"] in state.zones
    zone_map = state.zone_maps[zone["id"]]
    assert zone_map["source"] == "osm"
    assert {c["name"] for c in zone_map["communities"]} == {"Sierra Vista", "Pine Flat"}
    assert [s["name"] for s in zone_map["shelters"]] == ["Vista High School", "Eastside Hall"]
    assert len(zone_map["grid"]["in_zone"]) == zone_map["grid"]["rows"] * zone_map["grid"]["cols"]
    assert zone_map["elevation"] == "flat"
    messages = [e["payload"]["message"] for e in state.log]
    assert any("flat ground" in m for m in messages)


def test_rejects_bad_outlines(client) -> None:
    bowtie = [[34.19, -118.09], [34.225, -118.03], [34.19, -118.03], [34.225, -118.09]]
    assert client.post("/zones", json={"name": "x", "polygon": bowtie}).status_code == 400
    tiny = [[34.19, -118.09], [34.19, -118.0899], [34.1901, -118.09]]
    assert client.post("/zones", json={"name": "x", "polygon": tiny}).status_code == 400
    huge = [[34.0, -119.0], [34.0, -118.0], [35.0, -118.0], [35.0, -119.0]]
    assert client.post("/zones", json={"name": "x", "polygon": huge}).status_code == 400


def test_edge_plan_then_edit_and_deploy(client) -> None:
    zone_id = client.post("/zones", json={"name": "Ridge", "polygon": ZONE}).json()["id"]

    plan = client.post(f"/zones/{zone_id}/edge-plan").json()
    assert plan["coverage_pct"] >= 90
    assert all(s["status"] == "pending" for s in plan["servers"])

    edited = [{"id": s["id"], "lat": s["lat"], "lon": s["lon"]} for s in plan["servers"][:-1]]
    edited.append({"lat": 34.2, "lon": -118.06})  # operator adds one
    res = client.post(f"/zones/{zone_id}/edge-servers", json={"servers": edited}).json()
    assert all(s["status"] == "deployed" for s in res["servers"])
    assert len({s["id"] for s in res["servers"]}) == len(res["servers"])
    assert 0 < res["coverage_pct"] <= 100
    assert client.runtime.state.edge_plans[zone_id]["coverage_pct"] == res["coverage_pct"]


def test_operator_can_replace_shelters(client) -> None:
    zone_id = client.post("/zones", json={"name": "Ridge", "polygon": ZONE}).json()["id"]
    res = client.put(f"/zones/{zone_id}/shelters", json={"shelters": [{"name": "Fairgrounds", "lat": 34.16, "lon": -118.0}]})
    assert res.status_code == 200
    assert [s["name"] for s in client.runtime.state.zone_maps[zone_id]["shelters"]] == ["Fairgrounds"]


def test_delete_zone(client) -> None:
    zone_id = client.post("/zones", json={"name": "Ridge", "polygon": ZONE}).json()["id"]
    assert client.delete(f"/zones/{zone_id}").status_code == 200
    assert zone_id not in client.runtime.state.zones
    assert client.delete(f"/zones/{zone_id}").status_code == 404
