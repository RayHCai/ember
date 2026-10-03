"""The zone grid: square cells of about 100 m over the polygon's bounding box.

Cells are laid out in equal steps of latitude and longitude, so the whole grid
maps exactly onto a lat/lon rectangle (the web drapes one image over it).
Row 0 is the southern edge; indexes run row-major.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from .core import METERS_PER_DEG_LAT, LatLon, bbox, meters_per_deg_lon, point_in_polygon


@dataclass
class ZoneGrid:
    south: float
    west: float
    dlat: float
    dlon: float
    rows: int
    cols: int
    cell_m: float
    in_zone: list[bool] = field(repr=False)

    @classmethod
    def from_polygon(cls, polygon: Sequence[LatLon], cell_m: float) -> "ZoneGrid":
        s, w, n, e = bbox(polygon)
        dlat = cell_m / METERS_PER_DEG_LAT
        dlon = cell_m / meters_per_deg_lon((s + n) / 2)
        rows = max(1, int((n - s) / dlat) + 1)
        cols = max(1, int((e - w) / dlon) + 1)
        grid = cls(s, w, dlat, dlon, rows, cols, cell_m, [])
        grid.in_zone = [point_in_polygon(grid.center(i), polygon) for i in range(rows * cols)]
        return grid

    @property
    def size(self) -> int:
        return self.rows * self.cols

    @property
    def north(self) -> float:
        return self.south + self.rows * self.dlat

    @property
    def east(self) -> float:
        return self.west + self.cols * self.dlon

    def index(self, row: int, col: int) -> int:
        return row * self.cols + col

    def row_col(self, index: int) -> tuple[int, int]:
        return divmod(index, self.cols)

    def center(self, index: int) -> LatLon:
        row, col = divmod(index, self.cols)
        return (self.south + (row + 0.5) * self.dlat, self.west + (col + 0.5) * self.dlon)

    def cell_at(self, p: LatLon) -> int | None:
        row = int((p[0] - self.south) / self.dlat)
        col = int((p[1] - self.west) / self.dlon)
        if 0 <= row < self.rows and 0 <= col < self.cols:
            return self.index(row, col)
        return None

    def zone_cells(self) -> list[int]:
        return [i for i, inside in enumerate(self.in_zone) if inside]

    def to_payload(self) -> dict:
        return {
            "south": self.south,
            "west": self.west,
            "north": self.north,
            "east": self.east,
            "dlat": self.dlat,
            "dlon": self.dlon,
            "rows": self.rows,
            "cols": self.cols,
            "cell_m": self.cell_m,
            # One character per cell, row-major from the south-west corner.
            "in_zone": "".join("1" if v else "0" for v in self.in_zone),
        }
