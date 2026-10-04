"""Deterministic, world-anchored noise so flames and smoke have texture that stays put on the
ground as the drone moves (and flickers over time).

Two lookups of one texture at incommensurate scales and a 37 degree rotation are averaged,
so the pattern never visibly repeats."""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
from scipy.ndimage import zoom

from .sampling import Bilinear

SIZE = 512
_ROT = math.radians(37.0)
_GOLDEN = 1.6180339887


@lru_cache(maxsize=1)
def _texture() -> np.ndarray:
    rng = np.random.default_rng(20230808)
    tex = np.zeros((SIZE, SIZE), dtype=np.float32)
    amp, total = 1.0, 0.0
    for cells in (8, 16, 32, 64, 128, 256):
        base = rng.random((cells, cells)).astype(np.float32)
        tiled = np.tile(base, (3, 3))  # tile so the upsampled texture wraps seamlessly
        up = zoom(tiled, SIZE / cells, order=3, mode="wrap")[SIZE : 2 * SIZE, SIZE : 2 * SIZE]
        tex += amp * up
        total += amp
        amp *= 0.6
    tex /= total
    tex -= tex.min()
    tex /= tex.max()
    return tex


def _lookup(east: np.ndarray, north: np.ndarray, scale_m: float) -> np.ndarray:
    # Wrap first: the sampler needs small coordinates (see sampling.py).
    k = np.float32(8.0 / scale_m)
    cols = np.mod(east * k, SIZE)
    rows = np.mod(-north * k, SIZE)
    return Bilinear(rows, cols, (SIZE, SIZE), wrap=True)(_texture())


# Noise is anchored to a fixed local origin so float32 keeps millimetre precision.
_ORIGIN = (740000.0, 2308000.0)


def sample(
    east: np.ndarray, north: np.ndarray, scale_m: float, shift: tuple[float, float] = (0.0, 0.0)
) -> np.ndarray:
    """Noise in 0..1 at world coordinates (metres); features range from ~scale/4 to ~4*scale."""
    e = (np.asarray(east) - (_ORIGIN[0] - shift[0])).astype(np.float32)
    n = (np.asarray(north) - (_ORIGIN[1] - shift[1])).astype(np.float32)
    a = _lookup(e, n, scale_m)
    c, s = math.cos(_ROT), math.sin(_ROT)
    e2 = (c * e - s * n) / _GOLDEN + 1234.5
    n2 = (s * e + c * n) / _GOLDEN - 777.7
    b = _lookup(e2, n2, scale_m)
    return np.asarray(np.clip((a + b - 1.0) * 1.7 + 0.5, 0.0, 1.0))


def smoothstep(lo: float, hi: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)
