"""YOLO risk detector on ONNX Runtime (the `yolo` extra), for an Ultralytics YOLOv8/11 export.

The model sees any RGB view, oblique or nadir, so it is trained on mixed ground, aerial and drone
imagery. Class names come from the model's `names` metadata and map to a risk by keyword: fire and
flame are `on_fire`; smoke, ember, dry fuel and anything named at-risk are `at_risk`; other classes
are ignored.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from ..camera import Frame
from .detector import Detection2D, Risk, nms

ON_FIRE_WORDS = ("fire", "flame", "burning")
AT_RISK_WORDS = ("smoke", "ember", "dry", "risk", "smoulder", "smolder", "char")


def risk_for_label(label: str) -> Risk | None:
    name = label.lower().replace("-", "_")
    if "risk" in name:
        return "at_risk"
    if any(w in name for w in ON_FIRE_WORDS):
        return "on_fire"
    if any(w in name for w in AT_RISK_WORDS):
        return "at_risk"
    return None


def letterbox(
    rgb: NDArray[np.uint8], size: int
) -> tuple[NDArray[np.float32], float, tuple[float, float]]:
    """Resize keeping aspect into a grey `size` square; NCHW float in 0..1, scale and padding."""
    h, w = rgb.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = np.asarray(Image.fromarray(rgb).resize((nw, nh), Image.Resampling.BILINEAR))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    px, py = (size - nw) / 2, (size - nh) / 2
    canvas[int(py) : int(py) + nh, int(px) : int(px) + nw] = resized
    tensor = canvas.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    return tensor, scale, (float(int(px)), float(int(py)))


def decode(
    raw: NDArray[np.float32],
    conf: float,
    iou: float,
    scale: float,
    pad: tuple[float, float],
    image_size: tuple[int, int],
    classes: int,
) -> list[tuple[tuple[float, float, float, float], int, float]]:
    """Boxes in source pixels, class index and score from a (1, 4 + classes, anchors) output
    (or its transpose, which some exports produce)."""
    out = raw[0]
    if out.shape[0] != 4 + classes:
        out = out.T
    if out.shape[0] != 4 + classes:
        raise ValueError(f"YOLO output {raw.shape} does not fit {classes} classes")
    boxes_cxcywh, scores_all = out[:4].T, out[4:].T
    cls = scores_all.argmax(axis=1)
    score = scores_all[np.arange(len(cls)), cls]
    keep = score >= conf
    if not keep.any():
        return []
    b, cls, score = boxes_cxcywh[keep], cls[keep], score[keep]
    xyxy = np.stack(
        [
            b[:, 0] - b[:, 2] / 2,
            b[:, 1] - b[:, 3] / 2,
            b[:, 0] + b[:, 2] / 2,
            b[:, 1] + b[:, 3] / 2,
        ],
        1,
    )
    xyxy[:, [0, 2]] = (xyxy[:, [0, 2]] - pad[0]) / scale
    xyxy[:, [1, 3]] = (xyxy[:, [1, 3]] - pad[1]) / scale
    xyxy[:, [0, 2]] = xyxy[:, [0, 2]].clip(0, image_size[0])
    xyxy[:, [1, 3]] = xyxy[:, [1, 3]].clip(0, image_size[1])
    found = []
    for c in np.unique(cls):
        idx = np.flatnonzero(cls == c)
        for k in nms(xyxy[idx], score[idx], iou):
            i = idx[k]
            box = cast(tuple[float, float, float, float], tuple(float(v) for v in xyxy[i]))
            found.append((box, int(c), float(score[i])))
    return found


class YoloDetector:
    def __init__(
        self,
        model_path: Path,
        conf: float = 0.3,
        iou: float = 0.5,
        names: list[str] | None = None,
    ) -> None:
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError(
                "YOLO needs onnxruntime: uv sync --all-packages --extra yolo"
            ) from exc
        if not model_path.is_file():
            raise FileNotFoundError(f"YOLO model {model_path} not found")
        self.session: Any = ort.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        inp = self.session.get_inputs()[0]
        self.input_name: str = inp.name
        side = inp.shape[2]
        self.size = side if isinstance(side, int) else 640
        self.names = names or _names_from_metadata(self.session) or []
        if not self.names:
            raise ValueError(f"{model_path}: no class names in metadata; pass names explicitly")
        self.risks = [risk_for_label(n) for n in self.names]
        if not any(self.risks):
            raise ValueError(f"{model_path}: none of the classes {self.names} map to a risk")
        self.conf, self.iou = conf, iou
        self.name = f"yolo:{model_path.stem}"

    def detect(self, frame: Frame) -> list[Detection2D]:
        rgb = frame.images.rgb
        tensor, scale, pad = letterbox(rgb, self.size)
        raw = self.session.run(None, {self.input_name: tensor})[0]
        found = []
        size = (rgb.shape[1], rgb.shape[0])
        sx, sy = frame.camera.width_px / size[0], frame.camera.height_px / size[1]
        out = np.asarray(raw, dtype=np.float32)
        for box, c, score in decode(out, self.conf, self.iou, scale, pad, size, len(self.names)):
            risk = self.risks[c]
            if risk is None:
                continue
            scaled = (box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy)
            found.append(Detection2D(risk, score, scaled, self.names[c]))
        return found


def _names_from_metadata(session: Any) -> list[str] | None:
    raw = session.get_modelmeta().custom_metadata_map.get("names")
    if not raw:
        return None
    parsed = ast.literal_eval(raw)
    if isinstance(parsed, dict):
        return [str(parsed[k]) for k in sorted(parsed)]
    if isinstance(parsed, list):
        return [str(n) for n in parsed]
    return None
