"""The mission grid: what the swarm has seen, how tall it is, and where the risk is.

Layout is the contract's (packages/contracts/src/droneLink.ts, `MappingMission`): a square of
`cols` cells a side centred on the edge server, row 0 south, col 0 west, index `row * cols + col`.
Heights are 2.5D: the highest point seen in each cell over the ground estimate, which is the
lowest point seen within a few cells (under closed canopy a cell may never see the forest floor,
but a gap nearby usually does). Only frames with depth measure heights.
"""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from ..geo import FloatArray, inside_polygon
from ..link.messages import PeerCoverage
from ..perception.detector import RISK_RANK, Risk

# Height changes smaller than this are not worth telling the swarm about.
HEIGHT_RESEND_M = 1.0
# Cells a side of the window the ground estimate looks for its lowest return in.
GROUND_WINDOW = 5


class MissionGrid:
    def __init__(
        self,
        radius_m: float,
        cell_m: float,
        margin_m: float,
        boundary_xy: FloatArray | None = None,
    ) -> None:
        self.radius_m = radius_m
        self.cell_m = cell_m
        self.cols = math.ceil(2 * radius_m / cell_m)
        self.x0 = -self.cols * cell_m / 2
        centres = self.x0 + (np.arange(self.cols) + 0.5) * cell_m
        self.cx, self.cy = np.meshgrid(centres, centres)
        self.fly_radius_m = radius_m - margin_m
        self.flyable = np.hypot(self.cx, self.cy) <= self.fly_radius_m
        self.target = self.flyable.copy()
        if boundary_xy is not None:
            self.target &= inside_polygon(self.cx, self.cy, boundary_xy)
        self.target_count = int(self.target.sum())
        if self.target_count == 0:
            raise ValueError("mission: the boundary and the connectivity disc do not overlap")
        shape = (self.cols, self.cols)
        self.observed = np.zeros(shape, dtype=bool)
        self.ground_z = np.full(shape, np.nan)
        self.top_z = np.full(shape, np.nan)
        self.peer_height = np.full(shape, np.nan)
        self.risk = np.zeros(shape, dtype=np.int8)
        self._ground: FloatArray | None = None
        self._touched: set[int] = set()
        self._sent_height: dict[int, float] = {}

    def cells(
        self, x: FloatArray, y: FloatArray
    ) -> tuple[NDArray[np.intp], NDArray[np.intp], NDArray[np.bool_]]:
        col = np.floor((x - self.x0) / self.cell_m).astype(np.intp)
        row = np.floor((y - self.x0) / self.cell_m).astype(np.intp)
        ok = (col >= 0) & (col < self.cols) & (row >= 0) & (row < self.cols)
        return np.where(ok, row, 0), np.where(ok, col, 0), ok

    def observe(self, x: FloatArray, y: FloatArray, z: FloatArray | None) -> int:
        """Mark cells under these points seen; measured z also feeds the height map. New cells."""
        row, col, ok = self.cells(x, y)
        row, col = row[ok], col[ok]
        if row.size == 0:
            return 0
        before = int(self.observed.sum())
        self.observed[row, col] = True
        if z is not None:
            zz = z[ok]
            np.fmin.at(self.ground_z, (row, col), zz)
            np.fmax.at(self.top_z, (row, col), zz)
            self._ground = None
        self._touched.update(np.unique(row * self.cols + col).tolist())
        return int(self.observed.sum()) - before

    def ground(self) -> FloatArray:
        """Ground height per cell, NaN where nothing within the window has been measured."""
        if self._ground is None:
            low = ndimage.minimum_filter(
                np.where(np.isnan(self.ground_z), np.inf, self.ground_z),
                size=GROUND_WINDOW,
                mode="nearest",
            )
            self._ground = np.where(np.isinf(low), np.nan, low)
        return self._ground

    def heights(self) -> FloatArray:
        """Surface height above the ground per cell, NaN where unknown."""
        own = np.clip(self.top_z - self.ground(), 0.0, None)
        out: FloatArray = np.fmax(own, self.peer_height)
        return out

    def merge(self, coverage: PeerCoverage) -> None:
        n = self.cols * self.cols
        for i, h in zip(coverage.cells, coverage.top_m, strict=True):
            if not 0 <= i < n:
                continue
            self.observed.flat[i] = True
            if h is not None:
                self.peer_height.flat[i] = np.fmax(self.peer_height.flat[i], h)
            # A peer already told the swarm about this cell.
            self._sent_height.setdefault(i, float("nan") if h is None else h)

    def take_fresh(self) -> PeerCoverage | None:
        """Cells to tell the swarm about: newly seen, or with a height that changed."""
        if not self._touched:
            return None
        h = self.heights()
        cells: list[int] = []
        tops: list[float | None] = []
        for i in sorted(self._touched):
            height = float(h.flat[i])
            sent = self._sent_height.get(i)
            known = not math.isnan(height)
            changed = known and (
                sent is None or math.isnan(sent) or abs(height - sent) >= HEIGHT_RESEND_M
            )
            if sent is not None and not changed:
                continue
            cells.append(i)
            tops.append(round(height, 1) if known else None)
            self._sent_height[i] = height
        self._touched.clear()
        return PeerCoverage(tuple(cells), tuple(tops)) if cells else None

    def coverage(self) -> float:
        return float((self.observed & self.target).sum()) / self.target_count

    def ground_at(self, x: float, y: float) -> float:
        row, col, ok = self.cells(np.array([x]), np.array([y]))
        if not ok[0]:
            return 0.0
        g = self.ground()[row[0], col[0]]
        return 0.0 if math.isnan(g) else float(g)

    def mark_risk(self, outline_xy: FloatArray, risk: Risk) -> int:
        """Raise the risk of cells under a ground outline. Cells touched."""
        lo, hi = outline_xy.min(axis=0), outline_xy.max(axis=0)
        r0, c0, _ = self.cells(np.array([lo[0]]), np.array([lo[1]]))
        r1, c1, _ = self.cells(np.array([hi[0]]), np.array([hi[1]]))
        rows = slice(max(0, int(r0[0])), min(self.cols, int(r1[0]) + 1))
        cols = slice(max(0, int(c0[0])), min(self.cols, int(c1[0]) + 1))
        inside = inside_polygon(self.cx[rows, cols], self.cy[rows, cols], outline_xy)
        if not inside.any():
            centre = outline_xy.mean(axis=0)
            r, c, ok = self.cells(np.array([centre[0]]), np.array([centre[1]]))
            if not ok[0]:
                return 0
            rows, cols = slice(int(r[0]), int(r[0]) + 1), slice(int(c[0]), int(c[0]) + 1)
            inside = np.ones((1, 1), dtype=bool)
        block = self.risk[rows, cols]
        block[inside] = np.maximum(block[inside], RISK_RANK[risk])
        return int(inside.sum())
