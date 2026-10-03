"""Baseline detector without learned weights: thermal thresholds, flame colour without thermal.

Works on any view (nadir, oblique, horizon) because it only looks at pixel values. It cannot see
dry fuel or smoke; those are what the YOLO model is for.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from ..camera import Frame
from .detector import Detection2D, Risk

# Same line Demo Data draws for hotspots; flames read 520-1200 K, smouldering debris 330-750 K.
HOT_K = 450.0
# Pre-heated fuel and embers ahead of a front; sunlit ground stays near 300-320 K.
WARM_K = 335.0


class HeuristicDetector:
    name = "heuristic"

    def __init__(
        self, hot_k: float = HOT_K, warm_k: float = WARM_K, min_area_frac: float = 2e-4
    ) -> None:
        self.hot_k = hot_k
        self.warm_k = warm_k
        self.min_area_frac = min_area_frac

    def detect(self, frame: Frame) -> list[Detection2D]:
        thermal = frame.images.thermal_k
        scale = (frame.camera.width_px, frame.camera.height_px)
        if thermal is not None:
            t = thermal.astype(np.float64)
            hot = t > self.hot_k
            warm = (t > self.warm_k) & ~ndimage.binary_dilation(hot, iterations=2)
            return [
                *self._boxes(hot, t, "on_fire", scale, lambda p: 0.55 + (p - self.hot_k) / 1000),
                *self._boxes(warm, t, "at_risk", scale, lambda p: 0.3 + (p - self.warm_k) / 300),
            ]
        rgb = frame.images.rgb.astype(np.int16)
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        flame = (r > 220) & (g > 90) & (r >= g) & (g > b) & (r - b > 100)
        brightness = rgb.sum(axis=-1).astype(np.float64)
        return self._boxes(
            flame, brightness, "on_fire", scale, lambda p: 0.35 + p / 2500, thermal=False
        )

    def _boxes(
        self,
        mask: NDArray[np.bool_],
        value: NDArray[np.float64],
        risk: Risk,
        rgb_size: tuple[int, int],
        confidence: Callable[[float], float],
        thermal: bool = True,
    ) -> list[Detection2D]:
        if not mask.any():
            return []
        grouped = ndimage.binary_closing(mask, structure=np.ones((3, 3)), iterations=1) | mask
        labels, _ = ndimage.label(grouped, structure=np.ones((3, 3)))
        h, w = mask.shape
        sx, sy = rgb_size[0] / w, rgb_size[1] / h
        min_px = max(2, int(self.min_area_frac * mask.size))
        out = []
        for i, sl in enumerate(ndimage.find_objects(labels), 1):
            if sl is None:
                continue
            region = (labels[sl] == i) & mask[sl]
            if region.sum() < min_px:
                continue
            peak = float(value[sl][region].max())
            conf = float(np.clip(confidence(peak), 0.05, 0.99))
            box = (sl[1].start * sx, sl[0].start * sy, sl[1].stop * sx, sl[0].stop * sy)
            out.append(Detection2D(risk, conf, box, risk, peak if thermal else None))
        return out
