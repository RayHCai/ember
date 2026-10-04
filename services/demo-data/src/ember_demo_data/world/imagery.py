"""Imagery resampled into the world frame: a whole-area ground texture per epoch and sharper
patches around wherever the viewer's camera is looking."""

from __future__ import annotations

import io
from collections.abc import Sequence
from functools import lru_cache
from typing import Any

import numpy as np
from PIL import Image

from ..tiles import sampler
from .frame import EXTENT, FRAME

MOSAIC_RES_M = 2.0
CHAINS = {
    "pre": ("pre_2020",),
    "post": ("maxar_20230812", "maxar_20230809", "pre_2020"),
}
FALLBACK_RGB = np.array([0.33, 0.35, 0.33], dtype=np.float32)


def sample_imagery(
    layer_ids: Sequence[str], x: np.ndarray, y: np.ndarray, res: float
) -> tuple[np.ndarray, np.ndarray]:
    """RGB (0..1) and availability at world points, from the first layer that has them."""
    lon, lat = FRAME.to_lonlat(x, y)
    lon, lat = np.asarray(lon), np.asarray(lat)
    rgb = np.zeros((*lon.shape, 3), dtype=np.float32)
    have = np.zeros(lon.shape, dtype=bool)
    for layer_id in layer_ids:
        need = ~have
        if not need.any():
            break
        vals, ok = sampler(layer_id).sample(lon[need], lat[need], res)
        idx = tuple(i[ok] for i in np.nonzero(need))
        rgb[idx] = vals[ok]
        have[idx] = True
    return rgb, have


def _render(
    kind: str, x0: float, y_top: float, nx: int, ny: int, res: float, block: int = 512
) -> np.ndarray:
    out = np.empty((ny, nx, 3), dtype=np.uint8)
    for r0 in range(0, ny, block):
        for c0 in range(0, nx, block):
            rows, cols = np.arange(r0, min(r0 + block, ny)), np.arange(c0, min(c0 + block, nx))
            X, Y = np.meshgrid(x0 + (cols + 0.5) * res, y_top - (rows + 0.5) * res)
            rgb, have = sample_imagery(CHAINS[kind], X, Y, res)
            rgb[~have] = FALLBACK_RGB
            out[r0 : r0 + len(rows), c0 : c0 + len(cols)] = (np.clip(rgb, 0, 1) * 255).astype(
                np.uint8
            )
    return out


def _jpeg(img: np.ndarray, quality: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def mosaic_size() -> tuple[int, int]:
    return round(EXTENT.width / MOSAIC_RES_M), round(EXTENT.height / MOSAIC_RES_M)


def build_mosaic(kind: str) -> bytes:
    """The whole coverage extent at 2 m; the first image row is the north edge."""
    nx, ny = mosaic_size()
    return _jpeg(_render(kind, EXTENT.min_x, EXTENT.max_y, nx, ny, MOSAIC_RES_M), 85)


PATCH_STEP_M = 64.0


@lru_cache(maxsize=48)
def _patch(kind: str, cx: float, cy: float, size_m: float, res_m: float) -> bytes:
    n = round(size_m / res_m)
    return _jpeg(_render(kind, cx - size_m / 2, cy + size_m / 2, n, n, res_m), 82)


def patch(
    kind: str, x: float, y: float, size_m: float, res_m: float
) -> tuple[bytes, dict[str, Any]]:
    """A patch centred near (x, y), snapped to a 64 m grid so neighbours share a cache entry."""
    if kind not in CHAINS:
        raise ValueError(f"imagery kind must be one of {sorted(CHAINS)}")
    if not (64 <= size_m <= 2048) or not (0.25 <= res_m <= 4) or size_m / res_m > 2048:
        raise ValueError(
            "size_m must be in [64, 2048], res_m in [0.25, 4], and size_m / res_m at most 2048"
        )
    cx, cy = round(x / PATCH_STEP_M) * PATCH_STEP_M, round(y / PATCH_STEP_M) * PATCH_STEP_M
    extent = {
        "min_x": cx - size_m / 2,
        "min_y": cy - size_m / 2,
        "max_x": cx + size_m / 2,
        "max_y": cy + size_m / 2,
    }
    return _patch(kind, cx, cy, size_m, res_m), extent
