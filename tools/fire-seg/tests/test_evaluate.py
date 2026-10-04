from pathlib import Path

import numpy as np
from ember_drone_runtime.camera import Frame
from ember_drone_runtime.perception import HeuristicDetector
from ember_drone_runtime.perception.detector import Detection2D
from ember_fire_seg.classes import FLAME, SMOKE
from ember_fire_seg.evaluate import evaluate, summary
from ember_fire_seg.labels import Instance, write_seg
from ember_fire_seg.synthetic import render
from PIL import Image


class Oracle:
    """Outlines exactly the flame square drawn by `split`; calls everything else smoke."""

    name = "oracle"

    def detect(self, frame: Frame) -> list[Detection2D]:
        ring = ((20.0, 10.0), (40.0, 10.0), (40.0, 30.0), (20.0, 30.0))
        return [
            Detection2D("on_fire", 0.9, (20, 10, 40, 30), "flame", outline=ring),
            Detection2D("at_risk", 0.4, (0, 0, 5, 5), "smoke"),
        ]


def split(tmp_path: Path) -> Path:
    images = tmp_path / "images" / "test"
    images.mkdir(parents=True)
    rgb = np.zeros((40, 60, 3), dtype=np.uint8)
    rgb[...] = (60, 120, 50)
    rgb[10:30, 20:40] = (255, 160, 40)
    for i in range(2):
        Image.fromarray(rgb).save(images / f"f{i}.png")
        square = np.array([[20, 10], [40, 10], [40, 30], [20, 30]]) / np.array([60, 40])
        write_seg(tmp_path / "labels" / "test" / f"f{i}.txt", [Instance(FLAME, square)])
    return images


def test_a_perfect_outline_scores_one_and_false_smoke_is_counted(tmp_path: Path) -> None:
    report = evaluate(Oracle(), split(tmp_path), baseline=HeuristicDetector())
    flame, smoke = report["classes"]["flame"], report["classes"]["smoke"]
    assert flame["mask_iou"] == 1.0 and flame["image_recall"] == 1.0
    assert smoke["mask_iou"] == 0.0 and smoke["image_precision"] == 0.0
    assert report["classes"]["burned"]["mask_iou"] is None
    # The colour baseline also finds a saturated orange square.
    assert report["baseline_flame"]["mask_iou"] > 0.9
    text = summary(report)
    assert "flame" in text and "baseline" in text


def test_synthetic_images_carry_labels_for_what_they_draw() -> None:
    rng = np.random.default_rng(3)
    seen = set()
    for _ in range(20):
        rgb, instances = render(rng, size=96)
        assert rgb.shape == (96, 96, 3)
        seen |= {i.cls for i in instances}
    assert FLAME in seen and SMOKE in seen
