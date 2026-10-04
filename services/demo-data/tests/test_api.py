"""End-to-end API tests. They need the downloaded and built data; skipped otherwise."""

import base64
import io

import numpy as np
import pytest
from ember_demo_data.config import DERIVED_DIR, LAYERS
from PIL import Image

pytestmark = pytest.mark.skipif(
    not (DERIVED_DIR / "arrival.tif").exists()
    or not all(layer.path.exists() for layer in LAYERS.values()),
    reason="run `demo-data download` and `demo-data build` first",
)


@pytest.fixture(scope="module")
def client():
    from ember_demo_data.api.app import app
    from fastapi.testclient import TestClient

    return TestClient(app)


BANYAN = dict(lat=20.8725, lon=-156.6772)


def test_rejects_wrong_places(client):
    r = client.get(
        "/v1/observation", params=dict(lat=21.3069, lon=-157.8583, t="2023-08-08T16:30:00-10:00")
    )
    assert r.status_code == 422 and r.json()["error"] == "out_of_coverage"
    r = client.get(
        "/v1/observation", params=dict(lat=-156.6772, lon=20.8725, t="2023-08-08T16:30:00-10:00")
    )
    assert r.status_code == 422 and "swapped" in r.json()["message"]


def test_rejects_time_without_offset(client):
    r = client.get("/v1/observation", params=dict(**BANYAN, t="2023-08-08T16:30:00"))
    assert r.status_code == 422 and r.json()["error"] == "bad_time"


def test_observation_is_georeferenced_to_the_request(client):
    r = client.get(
        "/v1/observation",
        params=dict(**BANYAN, alt_m=150, t="2023-08-08T17:30:00-10:00", images="rgb,thermal"),
    )
    assert r.status_code == 200
    d = r.json()
    c = d["georef"]["center_ground"]
    # Even-sized frame: the centre pixel is half a pixel (~0.2 m) from the nadir point.
    assert abs(c["lat"] - BANYAN["lat"]) < 5e-6 and abs(c["lon"] - BANYAN["lon"]) < 5e-6
    rgb = Image.open(io.BytesIO(base64.b64decode(d["images"]["rgb"]["data"])))
    assert rgb.size == (640, 480)
    thermal = np.asarray(Image.open(io.BytesIO(base64.b64decode(d["images"]["thermal"]["data"]))))
    assert thermal.dtype == np.uint16 and thermal.max() / 10 > 500  # the town is burning at 17:30


def test_fire_timeline_at_one_place(client):
    """Front St Banyan tree: intact before the rekindle, burning in the evening, burned after."""

    def fractions(t):
        r = client.get(
            "/v1/observation", params=dict(**BANYAN, alt_m=150, t=t, images="", truth="true")
        )
        return r.json()["truth"]["class_fractions"], r.json()["imagery"]["name"]

    before, ep = fractions("2023-08-08T14:00:00-10:00")
    assert before.get("no_risk", 0) > 0.9 and ep == "fire"
    during, _ = fractions("2023-08-08T17:30:00-10:00")
    assert during.get("on_fire", 0) + during.get("smouldering", 0) > 0.5
    after, ep = fractions("2023-08-15T10:00:00-10:00")
    assert after.get("burned", 0) > 0.9 and ep == "post_fire_aerial"


def test_no_future_leakage_in_context(client):
    r = client.get("/v1/context/satellite", params=dict(**BANYAN, t="2023-08-08T15:00:00-10:00"))
    goes = r.json()["goes18"]
    assert goes["scan_start"] <= "2023-08-08T15:00:00-10:00" and goes["detections"] == []
    r = client.get("/v1/context/reports", params=dict(t="2023-08-08T15:00:00-10:00"))
    assert all(rep["time"] <= "2023-08-08T15:00:00-10:00" for rep in r.json()["reports"])


def test_tiles(client):
    assert client.get("/v1/tiles/pre_2020/18/16979/115520.jpg").status_code == 200
    r = client.get("/v1/tiles/scene/17/8489/57760.jpg", params=dict(t="2023-08-08T17:00:00-10:00"))
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert client.get("/v1/tiles/pre_2020/18/0/0.jpg").status_code == 404


def test_websocket_stream(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_json({"type": "configure", "drone_id": "d1", "images": []})
        assert ws.receive_json()["type"] == "configured"
        ws.send_json(
            {
                "type": "pose",
                "request_id": "a",
                **BANYAN,
                "alt_m": 120,
                "t": "2023-08-08T16:00:00-10:00",
            }
        )
        m = ws.receive_json()
        assert m["type"] == "observation" and m["request_id"] == "a" and m["drone_id"] == "d1"
        ws.send_json({"type": "pose", "request_id": "b", "lat": 0.0, "lon": 0.0})
        m = ws.receive_json()
        assert m["type"] == "error" and m["code"] == "out_of_coverage" and m["request_id"] == "b"
