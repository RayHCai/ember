"""Risk detection on camera frames and georeferencing of what is found."""

from __future__ import annotations

from pathlib import Path

from .detector import Detection2D, Detector, FusedDetector
from .heuristic import HeuristicDetector

__all__ = [
    "Detection2D",
    "Detector",
    "FusedDetector",
    "HeuristicDetector",
    "bundled_model",
    "make_detector",
]

BUNDLED_MODEL = Path("data", "fire-seg", "models", "fire-seg-v1.onnx")


def bundled_model() -> Path | None:
    """The fire-seg model committed to the repo, found from a checkout's install of this package."""
    for parent in Path(__file__).resolve().parents:
        if (parent / BUNDLED_MODEL).is_file():
            return parent / BUNDLED_MODEL
    return None


def make_detector(kind: str, yolo_model: Path | None) -> Detector:
    """`heuristic`, `yolo` (fused with the thermal baseline) or `auto` (yolo when a model is found).
    Without an explicit model, yolo and auto use the bundled one."""
    if kind not in ("auto", "yolo", "heuristic"):
        raise ValueError(f"unknown detector {kind!r}: use auto, yolo or heuristic")
    model = yolo_model or (bundled_model() if kind != "heuristic" else None)
    if kind == "heuristic" or (kind == "auto" and model is None):
        return HeuristicDetector()
    if model is None:
        raise ValueError("detector yolo needs a model path (--yolo-model or EMBER_YOLO_MODEL)")
    from .yolo import YoloDetector

    return FusedDetector([YoloDetector(model), HeuristicDetector()])
