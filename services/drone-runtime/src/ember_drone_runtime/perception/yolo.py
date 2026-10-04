"""YOLO risk detector on ONNX Runtime, for an Ultralytics YOLOv8/11 export.

The model sees any RGB view, oblique or nadir, so it is trained on mixed ground, aerial and drone
imagery (tools/fire-seg). Class names come from the model's `names` metadata and map to a risk by
keyword: fire and flame are `on_fire`; smoke, ember, burned ground, dry fuel and anything named
at-risk are `at_risk`; other classes are ignored.

Segmentation exports (`-seg`) give each region a mask: the outline traced from it is what gets
georeferenced, and the confidence is the class score times the mean mask probability inside it.
Detection exports give boxes only.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np
import onnxruntime as ort
from numpy.typing import NDArray
from PIL import Image

from ..camera import CameraSpec, Frame
from .detector import Box, Detection2D, Outline, Risk, nms
from .outline import outline

ON_FIRE_WORDS = ("fire", "flame", "burning")
AT_RISK_WORDS = ("smoke", "ember", "dry", "risk", "smoulder", "smolder", "char", "burned", "burnt")


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


@dataclass(frozen=True)
class Candidate:
    # In letterboxed input pixels; `to_source` maps them back.
    box: Box
    cls: int
    score: float
    # Mask coefficients of a segmentation model, else None.
    coeffs: NDArray[np.float32] | None


def decode(
    raw: NDArray[np.float32], conf: float, iou: float, classes: int, mask_dim: int = 0
) -> list[Candidate]:
    """Candidates from a (1, 4 + classes + mask_dim, anchors) output, or its transpose (some exports
    produce it), after per-class non-maximum suppression. Best first within each class."""
    rows = 4 + classes + mask_dim
    out = raw[0]
    if out.shape[0] != rows:
        out = out.T
    if out.shape[0] != rows:
        raise ValueError(f"YOLO output {raw.shape} does not fit {classes} classes, {mask_dim} mask")
    boxes_cxcywh, scores_all = out[:4].T, out[4 : 4 + classes].T
    coeffs_all = out[4 + classes :].T
    cls = scores_all.argmax(axis=1)
    score = scores_all[np.arange(len(cls)), cls]
    keep = score >= conf
    if not keep.any():
        return []
    b, cls, score, coeffs_all = boxes_cxcywh[keep], cls[keep], score[keep], coeffs_all[keep]
    xyxy = np.stack(
        [
            b[:, 0] - b[:, 2] / 2,
            b[:, 1] - b[:, 3] / 2,
            b[:, 0] + b[:, 2] / 2,
            b[:, 1] + b[:, 3] / 2,
        ],
        1,
    )
    found = []
    for c in np.unique(cls):
        idx = np.flatnonzero(cls == c)
        for k in nms(xyxy[idx], score[idx], iou):
            i = idx[k]
            box = cast(Box, tuple(float(v) for v in xyxy[i]))
            found.append(
                Candidate(box, int(c), float(score[i]), coeffs_all[i] if mask_dim else None)
            )
    return found


def to_source(box: Box, scale: float, pad: tuple[float, float], image_size: tuple[int, int]) -> Box:
    """A letterboxed-input box in source image pixels, clipped to the image."""
    x0 = min(max((box[0] - pad[0]) / scale, 0.0), image_size[0])
    y0 = min(max((box[1] - pad[1]) / scale, 0.0), image_size[1])
    x1 = min(max((box[2] - pad[0]) / scale, 0.0), image_size[0])
    y1 = min(max((box[3] - pad[1]) / scale, 0.0), image_size[1])
    return (x0, y0, x1, y1)


def region_mask(
    coeffs: NDArray[np.float32], protos: NDArray[np.float32], box: Box, input_size: int
) -> tuple[NDArray[np.float32], tuple[int, int]]:
    """Mask logits around a candidate's box at input resolution, -inf outside the box, and the
    top-left input pixel of the returned array; positive is inside. `protos` is (mask_dim, mh, mw).

    Mirrors Ultralytics' `process_mask(upsample=True)` so the drone sees the masks training
    measured: logits are upsampled bilinearly, then cut to the box at input resolution. Only a
    window one prototype cell wider than the box is computed.
    """
    dim, mh, mw = protos.shape
    sx, sy = input_size / mw, input_size / mh
    c0 = int(np.clip(np.floor(box[0] / sx) - 1, 0, mw - 1))
    r0 = int(np.clip(np.floor(box[1] / sy) - 1, 0, mh - 1))
    c1 = int(np.clip(np.ceil(box[2] / sx) + 1, c0 + 1, mw))
    r1 = int(np.clip(np.ceil(box[3] / sy) + 1, r0 + 1, mh))
    small = (coeffs @ protos[:, r0:r1, c0:c1].reshape(dim, -1)).reshape(r1 - r0, c1 - c0)
    w, h = round((c1 - c0) * sx), round((r1 - r0) * sy)
    up = np.array(
        Image.fromarray(small.astype(np.float32)).resize((w, h), Image.Resampling.BILINEAR),
        dtype=np.float32,
    )
    ox, oy = round(c0 * sx), round(r0 * sy)
    xs, ys = np.arange(w) + ox, np.arange(h) + oy
    inside = ((ys >= box[1]) & (ys < box[3]))[:, None] & ((xs >= box[0]) & (xs < box[2]))[None]
    up[~inside] = -np.inf
    return up, (ox, oy)


class YoloDetector:
    def __init__(
        self,
        model_path: Path,
        conf: float = 0.3,
        iou: float = 0.5,
        names: list[str] | None = None,
    ) -> None:
        if not model_path.is_file():
            raise FileNotFoundError(f"YOLO model {model_path} not found")
        self.session: Any = ort.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        inp = self.session.get_inputs()[0]
        self.input_name: str = inp.name
        side = inp.shape[2]
        self.size = side if isinstance(side, int) else 640
        outputs = self.session.get_outputs()
        protos = outputs[1].shape if len(outputs) > 1 else None
        self.mask_dim = (
            protos[1]
            if protos is not None and len(protos) == 4 and isinstance(protos[1], int)
            else 0
        )
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
        outputs = self.session.run(None, {self.input_name: tensor})
        raw = np.asarray(outputs[0], dtype=np.float32)
        protos = np.asarray(outputs[1][0], dtype=np.float32) if self.mask_dim else None
        size = (rgb.shape[1], rgb.shape[0])
        to_cam = (frame.camera.width_px / size[0], frame.camera.height_px / size[1])
        found = []
        for cand in decode(raw, self.conf, self.iou, len(self.names), self.mask_dim):
            risk = self.risks[cand.cls]
            if risk is None:
                continue
            src = to_source(cand.box, scale, pad, size)
            box = (src[0] * to_cam[0], src[1] * to_cam[1], src[2] * to_cam[0], src[3] * to_cam[1])
            score, ring = cand.score, None
            if protos is not None and cand.coeffs is not None:
                score, ring = self._region(cand, protos, scale, pad, to_cam, frame.camera)
            found.append(Detection2D(risk, score, box, self.names[cand.cls], outline=ring))
        return found

    def _region(
        self,
        cand: Candidate,
        protos: NDArray[np.float32],
        scale: float,
        pad: tuple[float, float],
        to_cam: tuple[float, float],
        cam: CameraSpec,
    ) -> tuple[float, Outline | None]:
        assert cand.coeffs is not None
        logits, (ox, oy) = region_mask(cand.coeffs, protos, cand.box, self.size)
        mask = logits > 0
        if not mask.any():
            # Too small for the prototypes to resolve: keep the box, at half the evidence.
            return cand.score * 0.5, None
        ring = outline(mask)
        assert ring is not None
        xs = np.clip((ring[:, 0] + ox - pad[0]) / scale * to_cam[0], 0.0, cam.width_px)
        ys = np.clip((ring[:, 1] + oy - pad[1]) / scale * to_cam[1], 0.0, cam.height_px)
        pts = tuple((float(x), float(y)) for x, y in zip(xs, ys, strict=True))
        prob = 1.0 / (1.0 + np.exp(-logits[mask]))
        return cand.score * float(prob.mean()), pts


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
