"""Risk detection on camera frames and georeferencing of what is found."""

from __future__ import annotations

from pathlib import Path

from .detector import Detection2D, Detector, FusedDetector
from .heuristic import HeuristicDetector

__all__ = ["Detection2D", "Detector", "FusedDetector", "HeuristicDetector", "make_detector"]


def make_detector(kind: str, yolo_model: Path | None) -> Detector:
    """`heuristic`, `yolo` (needs a model; fused with the thermal baseline) or `auto`."""
    if kind == "heuristic" or (kind == "auto" and yolo_model is None):
        return HeuristicDetector()
    if kind in ("yolo", "auto"):
        if yolo_model is None:
            raise ValueError("detector yolo needs a model path (--yolo-model or EMBER_YOLO_MODEL)")
        from .yolo import YoloDetector

        return FusedDetector([YoloDetector(yolo_model), HeuristicDetector()])
    raise ValueError(f"unknown detector {kind!r}: use auto, yolo or heuristic")
