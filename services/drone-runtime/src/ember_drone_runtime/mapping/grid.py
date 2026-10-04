"""The mission grid: what the swarm has seen, how tall it is, and where the risk is.

Layout is the contract's (packages/contracts/src/droneLink.ts, `MappingMission`): a square of
`cols` cells a side centred on the edge server, row 0 south, col 0 west, index `row * cols + col`.
Heights are 2.5D: the highest point seen in each cell over the ground estimate, which is the
lowest point seen within a few cells (under closed canopy a cell may never see the forest floor,
but a gap nearby usually does). Only frames with depth measure heights. Fire evidence per cell is
in `evidence.py`.
"""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from ..geo import FloatArray, inside_polygon
from ..link.messages import PeerCoverage
from ..perception.detector import RISK_RANK, Risk
from .evidence import EvidenceGrid, EvidenceParams

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
        evidence: EvidenceParams | None = None,
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
        self.evidence = EvidenceGrid(self.cols * self.cols, evidence or EvidenceParams())
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

    def flat_cells(self, x: FloatArray, y: FloatArray) -> NDArray[np.intp]:
        """Distinct flat indices of the cells under these points, inside the grid."""
        row, col, ok = self.cells(x, y)
        return np.unique(row[ok] * self.cols + col[ok])

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
        if coverage.evidence is not None:
            self.evidence.merge(coverage.evidence)
        for i, h in zip(coverage.cells, coverage.top_m, strict=True):
            if not 0 <= i < n:
                continue
            self.observed.flat[i] = True
            if h is not None:
                self.peer_height.flat[i] = np.fmax(self.peer_height.flat[i], h)
            # A peer already told the swarm about this cell.
            self._sent_height.setdefault(i, float("nan") if h is None else h)

    def take_fresh(self) -> PeerCoverage | None:
        """Cells to tell the swarm about (newly seen, or with a height that changed) and the fire
        evidence this drone added since the last call."""
        evidence = self.evidence.take_fresh()
        if not self._touched:
            return None if evidence is None else PeerCoverage((), (), evidence)
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
        if not cells and evidence is None:
            return None
        return PeerCoverage(tuple(cells), tuple(tops), evidence)

    def coverage(self) -> float:
        return float((self.observed & self.target).sum()) / self.target_count

    def ground_at(self, x: float, y: float) -> float:
        row, col, ok = self.cells(np.array([x]), np.array([y]))
        if not ok[0]:
            return 0.0
        g = self.ground()[row[0], col[0]]
        return 0.0 if math.isnan(g) else float(g)

    def cells_under(self, outline_xy: FloatArray) -> NDArray[np.intp]:
        """Flat indices of the cells whose centres fall inside a ground outline, or of the cell
        under its centre when it is smaller than a cell; empty off the grid."""
        lo = np.floor((outline_xy.min(axis=0) - self.x0) / self.cell_m).astype(int)
        hi = np.floor((outline_xy.max(axis=0) - self.x0) / self.cell_m).astype(int)
        rows = slice(max(0, int(lo[1])), max(0, min(self.cols, int(hi[1]) + 1)))
        cols = slice(max(0, int(lo[0])), max(0, min(self.cols, int(hi[0]) + 1)))
        inside = inside_polygon(self.cx[rows, cols], self.cy[rows, cols], outline_xy)
        if inside.any():
            rr, cc = np.nonzero(inside)
            return (rr + rows.start) * self.cols + cc + cols.start
        centre = outline_xy.mean(axis=0)
        return self.flat_cells(np.array([centre[0]]), np.array([centre[1]]))

    def mark_risk(self, cells: NDArray[np.intp], risk: Risk) -> None:
        """Raise the risk of these flat cells to at least `risk`."""
        self.risk.flat[cells] = np.maximum(self.risk.flat[cells], RISK_RANK[risk])
