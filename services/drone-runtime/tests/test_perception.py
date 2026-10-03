import math
from datetime import UTC, datetime

import numpy as np
import pytest
from ember_drone_runtime.camera import CameraSpec, Frame, Images, Pose
from ember_drone_runtime.geo import LatLng, LocalFrame
from ember_drone_runtime.perception import FusedDetector, HeuristicDetector
from ember_drone_runtime.perception.detector import Detection2D
from ember_drone_runtime.perception.georef import georeference
from ember_drone_runtime.perception.yolo import decode, letterbox, risk_for_label

SPEC = CameraSpec(128, 96, 90.0)
ORIGIN = LatLng(20.879, -156.676)


def frame(images: Images, pose: Pose | None = None) -> Frame:
    return Frame(
        1, datetime.now(UTC), pose or Pose(ORIGIN.lat, ORIGIN.lng, 100.0, 0.0, -90.0), SPEC, images
    )


def green() -> np.ndarray:
    rgb = np.zeros((96, 128, 3), dtype=np.uint8)
    rgb[...] = (60, 120, 50)
    return rgb


def test_thermal_hot_and_warm_regions_in_rgb_pixels() -> None:
    thermal = np.full((48, 64), 300.0, dtype=np.float32)
    thermal[10:20, 30:40] = 900.0
    thermal[30:34, 5:9] = 360.0
    found = HeuristicDetector().detect(frame(Images(green(), thermal_k=thermal)))
    by_risk = {d.risk: d for d in found}
    assert set(by_risk) == {"on_fire", "at_risk"}
    # Thermal is half the RGB size, so boxes double.
    assert by_risk["on_fire"].bbox == (60.0, 20.0, 80.0, 40.0)
    assert by_risk["on_fire"].peak_temp_k == 900.0
    assert by_risk["at_risk"].bbox == (10.0, 60.0, 18.0, 68.0)
    assert by_risk["on_fire"].confidence > by_risk["at_risk"].confidence


def test_flame_colour_without_thermal() -> None:
    rgb = green()
    rgb[40:60, 50:70] = (255, 160, 40)
    found = HeuristicDetector().detect(frame(Images(rgb)))
    assert [(d.risk, d.bbox) for d in found] == [("on_fire", (50.0, 40.0, 70.0, 60.0))]
    assert HeuristicDetector().detect(frame(Images(green()))) == []


class Fixed:
    def __init__(self, name: str, found: list[Detection2D]) -> None:
        self.name = name
        self.found = found

    def detect(self, frame: Frame) -> list[Detection2D]:
        return self.found


def test_fused_detector_merges_overlapping_boxes_of_one_risk() -> None:
    a = Detection2D("on_fire", 0.6, (10, 10, 50, 50), "fire")
    b = Detection2D("on_fire", 0.5, (12, 12, 52, 52), "on_fire", 800.0)
    c = Detection2D("at_risk", 0.5, (12, 12, 52, 52), "smoke")
    fused = FusedDetector([Fixed("yolo", [a, c]), Fixed("heuristic", [b])])
    found = fused.detect(frame(Images(green())))
    assert fused.name == "yolo+heuristic"
    fire = [d for d in found if d.risk == "on_fire"]
    assert len(found) == 2 and len(fire) == 1
    assert fire[0].bbox == (10, 10, 52, 52) and fire[0].peak_temp_k == 800.0
    assert math.isclose(fire[0].confidence, 0.8)


@pytest.mark.parametrize(
    ("label", "risk"),
    [("fire", "on_fire"), ("Flame", "on_fire"), ("smoke", "at_risk"), ("dry-vegetation", "at_risk"),
     ("at_risk", "at_risk"), ("on_fire", "on_fire"), ("person", None)],
)  # fmt: skip
def test_yolo_class_names_map_to_risk(label: str, risk: str | None) -> None:
    assert risk_for_label(label) == risk


def test_yolo_decode_undoes_letterbox_and_suppresses_duplicates() -> None:
    rgb = np.zeros((480, 640, 3), dtype=np.uint8)
    tensor, scale, pad = letterbox(rgb, 320)
    assert tensor.shape == (1, 3, 320, 320) and scale == 0.5 and pad == (0.0, 40.0)
    # Two overlapping class-0 boxes and one class-1 box, as (cx, cy, w, h, score0, score1).
    anchors = np.array(
        [
            [100, 140, 40, 40, 0.9, 0.0],
            [102, 141, 40, 40, 0.8, 0.0],
            [200, 200, 20, 20, 0.0, 0.6],
            [50, 50, 10, 10, 0.1, 0.1],
        ],
        dtype=np.float32,
    )
    raw = anchors.T[None]
    found = decode(raw, 0.3, 0.5, scale, pad, (640, 480), classes=2)
    assert len(found) == 2
    box, cls, score = found[0]
    assert cls == 0 and math.isclose(score, 0.9, rel_tol=1e-6)
    assert np.allclose(box, (160, 160, 240, 240))


def test_georeference_nadir_box_on_flat_ground() -> None:
    f = frame(Images(green()))
    local = LocalFrame(ORIGIN)
    whole = Detection2D("on_fire", 0.9, (0, 0, 128, 96), "fire")
    r = georeference(whole, "d-1-0", f, np.array([0.0, 0.0, 100.0]), 0.0, local, 2000.0)
    w, h = SPEC.footprint_m(100.0)
    assert math.isclose(r.area_m2, w * h, rel_tol=1e-6)
    assert np.allclose(local.point(r.center), (0.0, 0.0), atol=1e-6)
    # Clockwise from the image's top-left: north-west first when facing north.
    x, y = local.point(r.ground[0])
    assert x < 0 and y > 0


def test_georeference_uses_depth_for_raised_surfaces() -> None:
    depth = np.full((96, 128), 60.0, dtype=np.float32)
    f = frame(Images(green(), depth_m=depth))
    whole = Detection2D("on_fire", 0.9, (0, 0, 128, 96), "fire")
    r = georeference(
        whole, "d-1-0", f, np.array([0.0, 0.0, 100.0]), 0.0, LocalFrame(ORIGIN), 2000.0
    )
    w, h = SPEC.footprint_m(60.0)
    assert math.isclose(r.area_m2, w * h, rel_tol=1e-6)
