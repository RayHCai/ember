import base64
import io
import json
import math
import random
from pathlib import Path

import httpx
import numpy as np
from ember_fire_seg.classes import BURNED, FLAME
from ember_fire_seg.demo_data import (
    COVERAGE,
    FIRE_START,
    M_PER_DEG_LAT,
    aim,
    fire_points,
    label_instances,
    plan_shot,
    stage_demo_data,
)
from ember_fire_seg.labels import read_seg
from PIL import Image


def test_aiming_puts_the_target_at_the_image_centre() -> None:
    target = (20.88, -156.67)
    lat, lon = aim(target, 100.0, 90.0, -45.0)
    # Looking east at 45 degrees from 100 m, the drone hovers 100 m west of the target.
    east = (target[1] - lon) * M_PER_DEG_LAT * math.cos(math.radians(target[0]))
    assert math.isclose(east, 100.0, rel_tol=1e-6) and math.isclose(lat, target[0])
    assert aim(target, 100.0, 0.0, -90.0) == target


def test_shots_stay_inside_demo_datas_coverage() -> None:
    rng = random.Random(1)
    for _ in range(200):
        s = plan_shot(rng, FIRE_START, [(20.875, -156.672)])
        assert COVERAGE[0] < s.lat < COVERAGE[2] and COVERAGE[1] < s.lon < COVERAGE[3]
        assert -90.0 <= s.pitch_deg <= -25.0 and 40.0 <= s.alt_m <= 200.0


def test_fire_points_read_on_fire_polygons_only() -> None:
    truth = {
        "features": [
            {"properties": {"class": "on_fire"},
             "geometry": {"type": "Polygon", "coordinates": [[[-156.67, 20.88], [-156.66, 20.88],
                                                              [-156.66, 20.87]]]}},
            {"properties": {"class": "burned"},
             "geometry": {"type": "Polygon", "coordinates": [[[-156.6, 20.8], [-156.6, 20.9],
                                                              [-156.5, 20.9]]]}},
            {"properties": {"class": "on_fire"},
             "geometry": {"type": "MultiPolygon", "coordinates": [[[[-156.65, 20.86],
                                                                    [-156.64, 20.86],
                                                                    [-156.64, 20.85]]]]}},
        ]
    }  # fmt: skip
    points = fire_points(truth)
    assert len(points) == 6 and points[0] == (20.88, -156.67)


def labels_image() -> np.ndarray:
    labels = np.zeros((48, 64), dtype=np.uint8)
    labels[10:20, 10:30] = 2
    labels[30:40, 5:25] = 4
    labels[30:40, 25:35] = 3
    labels[:, 60:] = 255
    return labels


def thermal_image() -> np.ndarray:
    """Flames drawn on the left half of the on-fire cells only."""
    thermal = np.full((48, 64), 305.0, dtype=np.float32)
    thermal[10:20, 10:20] = 900.0
    return thermal


def test_flame_is_only_where_flame_is_drawn_and_the_rest_reads_burned() -> None:
    instances = label_instances(labels_image(), thermal_image(), night=False)
    flame = [i for i in instances if i.cls == FLAME]
    assert len(flame) == 1
    assert np.allclose(flame[0].polygon.min(axis=0), (10 / 64, 10 / 48))
    assert np.allclose(flame[0].polygon.max(axis=0), (20 / 64, 20 / 48))
    # The undrawn on-fire half, and the smouldering and burned cells together.
    assert sum(i.cls == BURNED for i in instances) == 2


def test_night_frames_label_flame_only() -> None:
    instances = label_instances(labels_image(), thermal_image(), night=True)
    assert [i.cls for i in instances] == [FLAME]


def png(array: np.ndarray, mode: str | None = None) -> str:
    buf = io.BytesIO()
    img = Image.fromarray(array)
    if mode == "P":
        img = img.convert("P")
        img.putdata(array.ravel().tolist())
    img.save(buf, format="PNG" if mode else "JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def thermal_png(kelvin: np.ndarray) -> str:
    """Demo Data's encoding at half the RGB width, like its default thermal camera."""
    dk = Image.fromarray(np.round(kelvin * 10).astype(np.uint16)[::2, ::2])
    buf = io.BytesIO()
    dk.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_stages_frames_from_a_demo_data_server(tmp_path: Path) -> None:
    calls: list[str] = []
    rgb = np.full((48, 64, 3), 100, dtype=np.uint8)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/v1/truth/fire":
            return httpx.Response(200, json={"features": []})
        q = request.url.params
        assert q["truth"] == "true" and q["images"] == "rgb,thermal,labels"
        images = {
            "rgb": {"format": "jpeg", "data": png(rgb)},
            "thermal": {"format": "png16_decikelvin", "data": thermal_png(thermal_image())},
            "labels": {"format": "png_palette", "data": png(labels_image(), "P")},
        }
        body = {"images": images, "environment": {"is_night": False}}
        return httpx.Response(200, content=json.dumps(body))

    client = httpx.Client(base_url="http://demo", transport=httpx.MockTransport(handler))
    info = stage_demo_data("http://demo", tmp_path / "demo", "demo", count=3, client=client)
    assert info.images == 3 and info.synthetic and info.aerial
    assert info.instances == {"burned": 6, "flame": 3}
    assert info.notes == {"night_frames": 0}
    assert calls.count("/v1/observation") == 3
    first = sorted((tmp_path / "demo" / "labels").iterdir())[0]
    assert sorted(i.cls for i in read_seg(first)) == [FLAME, BURNED, BURNED]
