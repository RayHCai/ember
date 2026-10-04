"""Score a detector on held-out frames the way the drone runs it.

The model goes through drone-runtime's own `YoloDetector`, so letterboxing, mask decoding and
outline tracing are exactly what ships. Each detection's outline (or box) is rasterised and
compared with the labelled regions per class:

- mask IoU over the whole split (intersection and union summed over images), the headline number;
- pixel precision and recall;
- image-level precision and recall: did the frame have the class at all.

The thermal-free colour baseline (`HeuristicDetector` without thermal) is scored on flame alongside,
so the report shows what the model adds over RGB thresholds.
"""

from __future__ import annotations

import platform
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from ember_drone_runtime.camera import CameraSpec, Frame, Images, Pose
from ember_drone_runtime.perception import Detector
from ember_drone_runtime.perception.detector import Detection2D
from PIL import Image

from .classes import CLASSES, FLAME, class_for_name
from .labels import Mask, class_mask, rasterize, read_seg
from .sources import IMAGE_SUFFIXES


@dataclass
class Score:
    inter: int = 0
    union: int = 0
    pred: int = 0
    truth: int = 0
    tp_img: int = 0
    fp_img: int = 0
    fn_img: int = 0

    def add(self, pred: Mask, truth: Mask) -> None:
        self.inter += int((pred & truth).sum())
        self.union += int((pred | truth).sum())
        self.pred += int(pred.sum())
        self.truth += int(truth.sum())
        has_pred, has_truth = bool(pred.any()), bool(truth.any())
        self.tp_img += has_pred and has_truth
        self.fp_img += has_pred and not has_truth
        self.fn_img += has_truth and not has_pred

    def report(self) -> dict[str, float | int | None]:
        return {
            "mask_iou": _ratio(self.inter, self.union),
            "pixel_precision": _ratio(self.inter, self.pred),
            "pixel_recall": _ratio(self.inter, self.truth),
            "image_precision": _ratio(self.tp_img, self.tp_img + self.fp_img),
            "image_recall": _ratio(self.tp_img, self.tp_img + self.fn_img),
            "frames_with_class": self.tp_img + self.fn_img,
        }


def detection_masks(found: list[Detection2D], shape: tuple[int, int]) -> dict[int, Mask]:
    out = {c: np.zeros(shape, dtype=bool) for c in range(len(CLASSES))}
    for d in found:
        cls = CLASSES.index(d.label) if d.label in CLASSES else class_for_name(d.label)
        if cls is None:
            continue
        x0, y0, x1, y1 = d.bbox
        ring = d.outline or ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        out[cls] |= rasterize(np.array(ring, dtype=np.float64), shape)
    return out


def frame_for(rgb: np.ndarray) -> Frame:
    """A frame whose camera pixels are the image's, so outlines come back in image pixels."""
    h, w = rgb.shape[:2]
    pose = Pose(0.0, 0.0, 100.0, 0.0, -90.0)
    return Frame(0, datetime.now(UTC), pose, CameraSpec(w, h, 84.0), Images(rgb))


def evaluate(
    detector: Detector,
    split: Path,
    baseline: Detector | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """`split` is a dataset's `images/<split>` folder; labels sit in the matching `labels` one."""
    labels_dir = split.parent.parent / "labels" / split.name
    images = sorted(p for p in split.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)[:limit]
    if not images:
        raise FileNotFoundError(f"no images in {split}")
    scores = {c: Score() for c in range(len(CLASSES))}
    base = Score()
    times = []
    for image in images:
        with Image.open(image) as im:
            rgb = np.asarray(im.convert("RGB"))
        shape = rgb.shape[:2]
        truth = read_seg(labels_dir / f"{image.stem}.txt")
        frame = frame_for(rgb)
        start = time.perf_counter()
        found = detector.detect(frame)
        times.append(time.perf_counter() - start)
        pred = detection_masks(found, shape)
        for c, score in scores.items():
            score.add(pred[c], class_mask(truth, c, shape))
        if baseline is not None:
            colour = detection_masks(baseline.detect(frame), shape)
            base.add(colour[FLAME], class_mask(truth, FLAME, shape))
    ms = np.array(times) * 1000
    return {
        "detector": detector.name,
        "split": str(split),
        "images": len(images),
        "classes": {CLASSES[c]: s.report() for c, s in scores.items()},
        "baseline_flame": None
        if baseline is None
        else {"detector": baseline.name, **base.report()},
        "latency_ms": {
            "mean": round(float(ms.mean()), 1),
            "p95": round(float(np.percentile(ms, 95)), 1),
        },
        "machine": f"{platform.system()} {platform.machine()}",
    }


def summary(report: dict[str, Any]) -> str:
    rows = [f"{report['detector']} on {report['images']} frames ({report['machine']})"]
    rows.append(f"{'class':<8} {'IoU':>6} {'px P':>6} {'px R':>6} {'img P':>6} {'img R':>6} frames")
    for name, s in report["classes"].items():
        rows.append(_row(name, s))
    if report["baseline_flame"] is not None:
        rows.append(_row("colour", report["baseline_flame"]) + "  (baseline, flame)")
    lat = report["latency_ms"]
    rows.append(f"latency {lat['mean']} ms mean, {lat['p95']} ms p95")
    return "\n".join(rows)


def _row(name: str, s: dict[str, Any]) -> str:
    def f(v: float | None) -> str:
        return "   -  " if v is None else f"{v:6.3f}"

    return (
        f"{name:<8} {f(s['mask_iou'])} {f(s['pixel_precision'])} {f(s['pixel_recall'])} "
        f"{f(s['image_precision'])} {f(s['image_recall'])} {s['frames_with_class']:>6}"
    )


def _ratio(a: int, b: int) -> float | None:
    return None if b == 0 else round(a / b, 4)
