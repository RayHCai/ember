"""Baseline detector without learned weights: thermal against its local background, flame colour
without thermal.

Works on any view (nadir, oblique, horizon) because it only looks at pixel values. It cannot see
dry fuel or smoke; those are what the YOLO model is for. Confidence grows with how hot and how big a
region is, so a speck of a few hot pixels is weak evidence; the mission grid's accumulation across
frames decides what is confirmed.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from ..camera import Frame
from .detector import Detection2D, Risk
from .outline import EIGHT, outline

# Flames read 520-1200 K; smouldering debris 330-750 K, so below 520 K hot is not yet flame.
HOT_K = 520.0
# Pre-heated fuel and embers ahead of a front; sunlit ground stays near 300-320 K.
WARM_K = 335.0
# Warm must also stand out from its neighbourhood, so a sun-baked roof is not a fire front.
WARM_CONTRAST_K = 20.0
# Area, in sensor pixels, at which a region reaches 63 % of the confidence its peak allows.
AREA_SCALE_PX = 12.0
# Background is the median of cool pixels in blocks this many pixels wide, smoothed over 5 blocks.
BACKGROUND_BLOCK = 8


class HeuristicDetector:
    name = "heuristic"

    def __init__(
        self,
        hot_k: float = HOT_K,
        warm_k: float = WARM_K,
        warm_contrast_k: float = WARM_CONTRAST_K,
        min_area_frac: float = 2e-4,
        min_pixels: int = 4,
        area_scale_px: float = AREA_SCALE_PX,
    ) -> None:
        self.hot_k = hot_k
        self.warm_k = warm_k
        self.warm_contrast_k = warm_contrast_k
        self.min_area_frac = min_area_frac
        self.min_pixels = min_pixels
        self.area_scale_px = area_scale_px

    def detect(self, frame: Frame) -> list[Detection2D]:
        thermal = frame.images.thermal_k
        scale = (frame.camera.width_px, frame.camera.height_px)
        if thermal is not None:
            t = thermal.astype(np.float64)
            hot = t > self.hot_k
            contrast = t - background(t, hot)
            warm = (
                (t > self.warm_k)
                & (contrast > self.warm_contrast_k)
                & ~ndimage.binary_dilation(hot, iterations=2)
            )
            return [
                *self._regions(
                    hot, t, t, "on_fire", scale, lambda p: min(0.97, 0.6 + (p - self.hot_k) / 800)
                ),
                *self._regions(
                    warm,
                    contrast,
                    t,
                    "at_risk",
                    scale,
                    lambda c: min(0.8, 0.3 + (c - self.warm_contrast_k) / 200),
                ),
            ]
        rgb = frame.images.rgb.astype(np.int16)
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        flame = (r > 220) & (g > 90) & (r >= g) & (g > b) & (r - b > 100)
        brightness = rgb.sum(axis=-1).astype(np.float64)
        return self._regions(
            flame, brightness, None, "on_fire", scale, lambda p: min(0.6, 0.35 + p / 2500)
        )

    def _regions(
        self,
        mask: NDArray[np.bool_],
        value: NDArray[np.float64],
        temps: NDArray[np.float64] | None,
        risk: Risk,
        cam_size: tuple[int, int],
        peak_confidence: Callable[[float], float],
    ) -> list[Detection2D]:
        if not mask.any():
            return []
        grouped = ndimage.binary_closing(mask, structure=np.ones((3, 3)), iterations=1) | mask
        labels, _ = ndimage.label(grouped, structure=EIGHT)
        h, w = mask.shape
        sx, sy = cam_size[0] / w, cam_size[1] / h
        min_px = max(self.min_pixels, int(self.min_area_frac * mask.size))
        out = []
        for i, sl in enumerate(ndimage.find_objects(labels), 1):
            if sl is None:
                continue
            component = labels[sl] == i
            region = component & mask[sl]
            area = int(region.sum())
            if area < min_px:
                continue
            peak = float(value[sl][region].max())
            size = 1.0 - float(np.exp(-area / self.area_scale_px))
            conf = float(np.clip(peak_confidence(peak) * size, 0.05, 0.99))
            box = (sl[1].start * sx, sl[0].start * sy, sl[1].stop * sx, sl[0].stop * sy)
            ring = outline(component)
            assert ring is not None
            pts = tuple(
                (float((x + sl[1].start) * sx), float((y + sl[0].start) * sy)) for x, y in ring
            )
            temp = None if temps is None else float(temps[sl][region].max())
            out.append(Detection2D(risk, conf, box, risk, temp, pts))
        return out


def background(t: NDArray[np.float64], exclude: NDArray[np.bool_]) -> NDArray[np.float64]:
    """Local background temperature: block medians of the pixels not excluded, smoothed."""
    h, w = t.shape
    n = BACKGROUND_BLOCK
    bh, bw = -(-h // n), -(-w // n)
    cool = np.where(exclude, np.nan, t)
    padded = np.pad(cool, ((0, bh * n - h), (0, bw * n - w)), constant_values=np.nan)
    blocks = padded.reshape(bh, n, bw, n).transpose(0, 2, 1, 3).reshape(bh, bw, n * n)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(blocks, axis=2)
        fill = np.nanmedian(cool) if np.isfinite(cool).any() else float(np.median(t))
    med = ndimage.median_filter(np.where(np.isnan(med), fill, med), size=5, mode="nearest")
    out: NDArray[np.float64] = np.repeat(np.repeat(med, n, axis=0), n, axis=1)[:h, :w]
    return out
