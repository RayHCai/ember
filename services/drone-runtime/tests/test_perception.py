import math
from datetime import UTC, datetime

import numpy as np
import pytest
from ember_drone_runtime.camera import CameraSpec, Frame, Images, Pose
from ember_drone_runtime.geo import LatLng, LocalFrame, polygon_area
from ember_drone_runtime.perception import FusedDetector, HeuristicDetector
from ember_drone_runtime.perception.detector import Detection2D
from ember_drone_runtime.perception.georef import georeference
from ember_drone_runtime.perception.outline import components, outline, simplify, trace
from ember_drone_runtime.perception.yolo import (
    YoloDetector,
    decode,
    letterbox,
    region_mask,
    risk_for_label,
    to_source,
)

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
    ring = ((12.0, 12.0), (52.0, 12.0), (30.0, 52.0))
    b = Detection2D("on_fire", 0.5, (12, 12, 52, 52), "on_fire", 800.0, ring)
    c = Detection2D("at_risk", 0.5, (12, 12, 52, 52), "smoke")
    fused = FusedDetector([Fixed("yolo", [a, c]), Fixed("heuristic", [b])])
    found = fused.detect(frame(Images(green())))
    assert fused.name == "yolo+heuristic"
    fire = [d for d in found if d.risk == "on_fire"]
    assert len(found) == 2 and len(fire) == 1
    assert fire[0].bbox == (10, 10, 52, 52) and fire[0].peak_temp_k == 800.0
    assert math.isclose(fire[0].confidence, 0.8)
    # The more confident member has no outline, so the other's is kept.
    assert fire[0].outline == ring


@pytest.mark.parametrize(
    ("label", "risk"),
    [("fire", "on_fire"), ("Flame", "on_fire"), ("smoke", "at_risk"), ("dry-vegetation", "at_risk"),
     ("at_risk", "at_risk"), ("on_fire", "on_fire"), ("burned", "at_risk"),
     ("burning-tree", "on_fire"), ("person", None)],
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
    found = decode(raw, 0.3, 0.5, classes=2)
    assert len(found) == 2
    best = found[0]
    assert best.cls == 0 and math.isclose(best.score, 0.9, rel_tol=1e-6) and best.coeffs is None
    assert np.allclose(to_source(best.box, scale, pad, (640, 480)), (160, 160, 240, 240))


def seg_protos() -> np.ndarray:
    """(2, 8, 8) prototypes for a 32 px input: channel 0 is positive on proto cells 2-5."""
    protos = np.full((2, 8, 8), -10.0, dtype=np.float32)
    protos[0, 2:6, 2:6] = 10.0
    return protos


def test_region_mask_is_the_prototype_blend_cropped_to_the_box() -> None:
    coeffs = np.array([1.0, 0.0], dtype=np.float32)
    logits, (ox, oy) = region_mask(coeffs, seg_protos(), (4.0, 4.0, 28.0, 20.0), 32)
    assert (ox, oy) == (0, 0)
    rows, cols = np.nonzero(logits > 0)
    # Positive on input pixels 8-23, cut at the box's bottom edge (y 20) at input resolution.
    assert abs(cols.min() + ox - 8) <= 1 and abs(cols.max() + ox - 23) <= 1
    assert rows.max() + oy == 19
    assert logits[0, 0] == -np.inf


class FakeSession:
    def __init__(self, outputs: list[np.ndarray]) -> None:
        self.outputs = outputs

    def run(self, _names: object, _feed: object) -> list[np.ndarray]:
        return self.outputs


def test_yolo_seg_detection_carries_the_mask_outline_in_camera_pixels() -> None:
    # One anchor: box (cx, cy, w, h) in input pixels, scores for 3 classes, 2 mask coefficients.
    anchor = np.array([16, 16, 24, 24, 0.9, 0.0, 0.0, 1.0, 0.0], dtype=np.float32)
    det = object.__new__(YoloDetector)
    det.session = FakeSession([anchor[None, :, None], seg_protos()[None]])
    det.input_name, det.size, det.mask_dim = "images", 32, 2
    det.names, det.risks = ["flame", "smoke", "person"], ["on_fire", "at_risk", None]
    det.conf, det.iou, det.name = 0.3, 0.5, "yolo:test"
    pose = Pose(ORIGIN.lat, ORIGIN.lng, 100.0, 0.0, -90.0)
    rgb = np.zeros((32, 32, 3), dtype=np.uint8)
    f = Frame(1, datetime.now(UTC), pose, CameraSpec(64, 64, 90.0), Images(rgb))
    [d] = det.detect(f)
    assert (d.risk, d.label) == ("on_fire", "flame")
    assert d.bbox == pytest.approx((8.0, 8.0, 56.0, 56.0))
    assert d.outline is not None
    ring = np.array(d.outline)
    # The mask covers input pixels 8-23, so camera pixels 16-48.
    assert np.allclose(ring.min(axis=0), (16, 16), atol=3)
    assert np.allclose(ring.max(axis=0), (48, 48), atol=3)
    assert 0.75 < d.confidence <= 0.9


def test_trace_follows_pixel_edges_clockwise() -> None:
    mask = np.zeros((6, 6), dtype=bool)
    mask[1:4, 1:3] = True
    mask[3, 3:5] = True  # an L of 8 pixels
    ring = trace(mask)
    assert tuple(ring[0]) == (1.0, 1.0)
    assert polygon_area(ring) == 8.0
    # Clockwise on the image (y down) is a positive shoelace sum.
    x, y = ring[:, 0], ring[:, 1]
    assert float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) > 0
    assert trace(np.ones((1, 1), dtype=bool)).tolist() == [[0, 0], [1, 0], [1, 1], [0, 1]]


def test_outline_simplifies_big_masks_and_keeps_the_largest_component() -> None:
    yy, xx = np.mgrid[:200, :200]
    disc = (xx - 100) ** 2 + (yy - 90) ** 2 <= 60**2
    disc[5, 5] = True
    ring = outline(disc, max_points=24)
    assert ring is not None and 3 <= len(ring) <= 24
    assert polygon_area(ring) == pytest.approx(disc.sum() - 1, rel=0.05)
    assert len(components(disc)) == 2 and len(components(disc, min_pixels=2)) == 1
    assert outline(np.zeros((4, 4), dtype=bool)) is None
    assert len(simplify(trace(disc), max_points=3)) == 3


def test_a_few_hot_pixels_are_weak_and_a_big_fire_is_strong() -> None:
    thermal = np.full((240, 320), 300.0, dtype=np.float32)
    thermal[100:104, 50:52] = 900.0  # 8 px
    thermal[150:190, 200:260] = 900.0
    found = HeuristicDetector(min_area_frac=0).detect(frame(Images(green(), thermal_k=thermal)))
    by_size = sorted(found, key=lambda d: (d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]))
    assert [d.risk for d in by_size] == ["on_fire", "on_fire"]
    assert by_size[0].confidence < 0.5 < 0.9 < by_size[1].confidence
    assert by_size[1].outline is not None


def test_uniformly_warm_ground_is_not_a_fire_front() -> None:
    thermal = np.full((48, 64), 345.0, dtype=np.float32)  # sun-baked, above the warm line
    thermal[20:26, 20:26] = 380.0
    found = HeuristicDetector().detect(frame(Images(green(), thermal_k=thermal)))
    assert [(d.risk, d.bbox) for d in found] == [("at_risk", (40.0, 40.0, 52.0, 52.0))]


def test_smouldering_below_the_flame_line_is_at_risk() -> None:
    thermal = np.full((48, 64), 300.0, dtype=np.float32)
    thermal[10:20, 10:20] = 480.0
    found = HeuristicDetector().detect(frame(Images(green(), thermal_k=thermal)))
    assert [d.risk for d in found] == ["at_risk"]


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


def test_georeference_projects_the_outline_not_the_box() -> None:
    f = frame(Images(green()))
    local = LocalFrame(ORIGIN)
    tri = ((0.0, 0.0), (128.0, 0.0), (0.0, 96.0))
    det = Detection2D("on_fire", 0.9, (0, 0, 128, 96), "fire", outline=tri)
    r = georeference(det, "d-1-0", f, np.array([0.0, 0.0, 100.0]), 0.0, local, 2000.0)
    w, h = SPEC.footprint_m(100.0)
    assert len(r.ground) == 3
    assert math.isclose(r.area_m2, w * h / 2, rel_tol=1e-6)
    # The triangle's centroid: a third of the way in from the north-west corner.
    assert np.allclose(local.point(r.center), (-w / 2 + w / 3, h / 2 - h / 3), atol=1e-3)
