"""Risk detectors: anything that turns a camera frame into risk boxes in image pixels."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import numpy as np

from ..camera import Frame

Risk = Literal["at_risk", "on_fire"]
RISK_RANK: dict[Risk, int] = {"at_risk": 1, "on_fire": 2}


@dataclass(frozen=True)
class Detection2D:
    risk: Risk
    confidence: float
    # [x0, y0, x1, y1] in the frame's RGB pixels, origin top-left.
    bbox: tuple[float, float, float, float]
    label: str
    peak_temp_k: float | None = None


class Detector(Protocol):
    name: str

    def detect(self, frame: Frame) -> list[Detection2D]: ...


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class FusedDetector:
    """Runs several detectors and merges boxes of the same risk that overlap."""

    def __init__(self, detectors: list[Detector], merge_iou: float = 0.4) -> None:
        self.detectors = detectors
        self.merge_iou = merge_iou
        self.name = "+".join(d.name for d in detectors)

    def detect(self, frame: Frame) -> list[Detection2D]:
        found = [d for det in self.detectors for d in det.detect(frame)]
        found.sort(key=lambda d: -d.confidence)
        kept: list[Detection2D] = []
        for d in found:
            twin = next(
                (
                    i
                    for i, k in enumerate(kept)
                    if k.risk == d.risk and iou(k.bbox, d.bbox) >= self.merge_iou
                ),
                None,
            )
            if twin is None:
                kept.append(d)
                continue
            k = kept[twin]
            box = (
                min(k.bbox[0], d.bbox[0]),
                min(k.bbox[1], d.bbox[1]),
                max(k.bbox[2], d.bbox[2]),
                max(k.bbox[3], d.bbox[3]),
            )
            temps = [t for t in (k.peak_temp_k, d.peak_temp_k) if t is not None]
            kept[twin] = Detection2D(
                k.risk,
                float(1 - (1 - k.confidence) * (1 - d.confidence)),
                box,
                k.label,
                max(temps) if temps else None,
            )
        return kept


def nms(boxes: np.ndarray, scores: np.ndarray, threshold: float) -> list[int]:
    """Indices of boxes (n, 4) kept by greedy non-maximum suppression, best first."""
    order = list(np.argsort(-scores))
    keep: list[int] = []
    x0, y0, x1, y1 = boxes.T
    areas = (x1 - x0) * (y1 - y0)
    while order:
        i = order.pop(0)
        keep.append(int(i))
        if not order:
            break
        rest = np.array(order)
        w = np.clip(np.minimum(x1[i], x1[rest]) - np.maximum(x0[i], x0[rest]), 0, None)
        h = np.clip(np.minimum(y1[i], y1[rest]) - np.maximum(y0[i], y0[rest]), 0, None)
        inter = w * h
        overlap = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = [int(j) for j, o in zip(rest, overlap, strict=True) if o < threshold]
    return keep
