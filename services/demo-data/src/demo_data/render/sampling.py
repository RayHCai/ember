"""Fast bilinear sampling at arbitrary points (OpenCV remap).

Coordinates follow the scipy.ndimage convention: pixel centres sit at integer (row, col).
OpenCV converts the coordinate maps to 16-bit fixed point internally, so coordinates must
stay within +-32767: callers pass array indices (at most a few thousand), and the noise
texture wraps its coordinates before sampling.
"""

from __future__ import annotations

import cv2
import numpy as np

LIMIT = 32000.0
WIDTH = 1024


class Bilinear:
    def __init__(self, rows: np.ndarray, cols: np.ndarray, shape: tuple[int, int], wrap: bool = False):
        self.shape = shape
        self.n = int(np.size(rows))
        rows = np.clip(np.asarray(rows, dtype=np.float64).ravel(), -LIMIT, LIMIT)
        cols = np.clip(np.asarray(cols, dtype=np.float64).ravel(), -LIMIT, LIMIT)
        # OpenCV also caps the output size at 32767 per side, so lay the points out in rows.
        lines = max(1, -(-self.n // WIDTH))
        pad = lines * WIDTH - self.n
        self.map_x = np.pad(cols.astype(np.float32), (0, pad)).reshape(lines, WIDTH)
        self.map_y = np.pad(rows.astype(np.float32), (0, pad)).reshape(lines, WIDTH)
        self.border = cv2.BORDER_WRAP if wrap else cv2.BORDER_CONSTANT

    def _remap(self, arr: np.ndarray, interp: int, cval: float) -> np.ndarray:
        out = cv2.remap(arr, self.map_x, self.map_y, interp, borderMode=self.border, borderValue=cval)
        if arr.ndim == 3:
            return out.reshape(-1, arr.shape[2])[: self.n]
        return out.reshape(-1)[: self.n]

    def __call__(self, arr: np.ndarray, cval: float = 0.0) -> np.ndarray:
        """Sample a (H, W) or (H, W, C) array; outside the array counts as cval.

        uint8 inputs are interpolated in 8-bit (results rounded to whole values), which suits
        imagery and 0/255 masks; float32 inputs keep full precision. Returns float32.
        """
        if arr.dtype == np.bool_:
            arr = arr.astype(np.uint8) * 255
        if arr.ndim == 3 and arr.shape[2] > 4:
            parts = [self(arr[:, :, i : i + 4], cval) for i in range(0, arr.shape[2], 4)]
            return np.concatenate([p if p.ndim == 2 else p[:, None] for p in parts], axis=1)
        if arr.dtype not in (np.uint8, np.float32):
            arr = arr.astype(np.float32)
        return self._remap(arr, cv2.INTER_LINEAR, cval).astype(np.float32, copy=False)

    def nearest(self, arr: np.ndarray, cval) -> np.ndarray:
        return self._remap(arr, cv2.INTER_NEAREST, cval)
