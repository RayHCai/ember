from fastapi.testclient import TestClient

from app.main import create_app
from app.runtime import Runtime


def make_client() -> tuple[TestClient, Runtime]:
    runtime = Runtime(speed=1)
    return TestClient(create_app(runtime)), runtime


def test_snapshot_arrives_first() -> None:
    client, _ = make_client()
    with client, client.websocket_connect("/ws") as ws:
        first = ws.receive_json()
    assert first["kind"] == "snapshot"
    payload = first["payload"]
    for key in ("sim", "zones", "edge_plans", "drones", "surveys", "reports", "incidents", "approvals", "log"):
        assert key in payload
    assert payload["sim"]["speed"] == 1


def test_snapshot_includes_existing_state() -> None:
    client, runtime = make_client()
    with client:
        runtime.bus.emit("zone", "z1", {"id": "z1", "name": "Ridge", "polygon": [], "area_km2": 1.0})
        runtime.bus.emit("log", "z1", {"message": "hello"})
        with client.websocket_connect("/ws") as ws:
            snapshot = ws.receive_json()["payload"]
    assert [z["id"] for z in snapshot["zones"]] == ["z1"]
    assert snapshot["log"][-1]["payload"]["message"] == "hello"


def test_published_event_reaches_client() -> None:
    client, runtime = make_client()
    with client, client.websocket_connect("/ws") as ws:
        ws.receive_json()  # snapshot
        # Published from the test thread: exercises the thread-safe path.
        runtime.bus.emit("decision", "z1", {"summary": "Held alerts for approval."})
        event = ws.receive_json()
    assert event["kind"] == "decision"
    assert event["zone_id"] == "z1"
    assert event["payload"] == {"summary": "Held alerts for approval."}
    assert event["ts"].endswith("Z")


def test_speed_change_is_broadcast() -> None:
    client, _ = make_client()
    with client, client.websocket_connect("/ws") as ws:
        ws.receive_json()  # snapshot
        res = client.post("/sim/speed", json={"speed": 360})
        assert res.status_code == 200
        event = ws.receive_json()
    assert event["kind"] == "sim"
    assert event["payload"]["speed"] == 360


def test_stub_routes_answer_501() -> None:
    client, _ = make_client()
    with client:
        res = client.post("/agent/chat")
    assert res.status_code == 501
