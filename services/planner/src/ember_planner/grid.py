"""Local metric frame and the planning grid every planner layer is a raster on.

Over a watch zone and its surroundings (tens of kilometres at most) a tangent plane is accurate to
well under a cell, so no projection library is needed.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import shapely
from numpy.typing import ArrayLike, NDArray

from .wire import GridSpec, LatLng

WGS84_A = 6378137.0
WGS84_E2 = 6.69437999014e-3

FloatArray = NDArray[np.float64]
BoolArray = NDArray[np.bool_]
IntArray = NDArray[np.int64]


class LocalFrame:
    """Metres east (x) and north (y) of an origin."""

    def __init__(self, origin: LatLng) -> None:
        self.origin = origin
        phi = math.radians(origin.lat)
        w = 1.0 - WGS84_E2 * math.sin(phi) ** 2
        self.m_per_deg_lat = math.radians(1.0) * WGS84_A * (1.0 - WGS84_E2) / w**1.5
        self.m_per_deg_lng = math.radians(1.0) * WGS84_A / math.sqrt(w) * math.cos(phi)

    def to_xy(self, lat: ArrayLike, lng: ArrayLike) -> tuple[FloatArray, FloatArray]:
        x = (np.asarray(lng, dtype=np.float64) - self.origin.lng) * self.m_per_deg_lng
        y = (np.asarray(lat, dtype=np.float64) - self.origin.lat) * self.m_per_deg_lat
        return x, y

    def point(self, p: LatLng) -> tuple[float, float]:
        x, y = self.to_xy(p.lat, p.lng)
        return float(x), float(y)

    def ring(self, ring: Sequence[LatLng]) -> FloatArray:
        x, y = self.to_xy([p.lat for p in ring], [p.lng for p in ring])
        return np.column_stack([x, y])

    def to_latlng(self, x: float, y: float) -> LatLng:
        return LatLng(
            lat=round(self.origin.lat + y / self.m_per_deg_lat, 7),
            lng=round(self.origin.lng + x / self.m_per_deg_lng, 7),
        )


@dataclass(frozen=True)
class Grid:
    """`rows` x `cols` square cells; row 0 is the southern edge, col 0 the western one."""

    frame: LocalFrame
    x0: float
    y0: float
    cell: float
    rows: int
    cols: int

    @property
    def size(self) -> int:
        return self.rows * self.cols

    @property
    def cell_ha(self) -> float:
        return self.cell * self.cell / 10_000.0

    def centers(self) -> tuple[FloatArray, FloatArray]:
        xs = self.x0 + (np.arange(self.cols) + 0.5) * self.cell
        ys = self.y0 + (np.arange(self.rows) + 0.5) * self.cell
        gx, gy = np.meshgrid(xs, ys)
        return gx, gy

    def center(self, r: int, c: int) -> tuple[float, float]:
        return self.x0 + (c + 0.5) * self.cell, self.y0 + (r + 0.5) * self.cell

    def cell_of(self, x: ArrayLike, y: ArrayLike) -> tuple[IntArray, IntArray, BoolArray]:
        """Row, column and whether the point is inside the grid."""
        c = np.floor((np.asarray(x, dtype=np.float64) - self.x0) / self.cell).astype(np.int64)
        r = np.floor((np.asarray(y, dtype=np.float64) - self.y0) / self.cell).astype(np.int64)
        inside = (r >= 0) & (r < self.rows) & (c >= 0) & (c < self.cols)
        return np.clip(r, 0, self.rows - 1), np.clip(c, 0, self.cols - 1), inside

    def spec(self) -> GridSpec:
        return GridSpec(
            south_west=self.frame.to_latlng(self.x0, self.y0),
            cell_size_m=self.cell,
            cols=self.cols,
            rows=self.rows,
        )

    def polygon_mask(self, ring: Sequence[LatLng]) -> BoolArray:
        """Cells whose centre is inside the ring; at least the cell of its centroid."""
        poly = shapely.Polygon(self.frame.ring(ring)).buffer(0)
        gx, gy = self.centers()
        mask = np.asarray(shapely.contains_xy(poly, gx, gy), dtype=np.bool_)
        if not mask.any() and not poly.is_empty:
            pt = poly.representative_point()
            r, c, inside = self.cell_of(pt.x, pt.y)
            if bool(inside):
                mask[int(r), int(c)] = True
        return mask

    def disk_mask(self, x: float, y: float, radius: float) -> BoolArray:
        gx, gy = self.centers()
        mask = (gx - x) ** 2 + (gy - y) ** 2 <= radius * radius
        r, c, inside = self.cell_of(x, y)
        if bool(inside):
            mask[int(r), int(c)] = True
        return np.asarray(mask, dtype=np.bool_)


def fit_grid(
    frame: LocalFrame,
    points: FloatArray,
    margin_m: float,
    min_cell_m: float,
    max_cells: int,
) -> Grid:
    """The smallest grid of at least `min_cell_m` cells and at most `max_cells` covering the
    points plus a margin."""
    lo = points.min(axis=0) - margin_m
    hi = points.max(axis=0) + margin_m
    w, h = float(hi[0] - lo[0]), float(hi[1] - lo[1])
    cell = max(min_cell_m, math.sqrt(w * h / max_cells))
    cols = max(1, math.ceil(w / cell))
    rows = max(1, math.ceil(h / cell))
    while cols * rows > max_cells:
        cell *= 1.05
        cols, rows = max(1, math.ceil(w / cell)), max(1, math.ceil(h / cell))
    return Grid(frame, float(lo[0]), float(lo[1]), cell, rows, cols)


def bearing_deg(dx: float, dy: float) -> float:
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0
