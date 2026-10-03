"""The 3D viewer's world frame: metres east (x) and north (y) of the coverage-box centre.

A plain linear lat/lon scaling at the centre latitude. Across the ~6 x 9 km box its distance
error stays below 0.05 %, and the viewer applies the exact same formula to drone poses, so
drones, trees, buildings and fire all line up with each other.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..config import AOI


def metres_per_degree(lat: float) -> tuple[float, float]:
    """(metres per degree of latitude, of longitude) on the WGS84 ellipsoid at `lat`."""
    p = math.radians(lat)
    m_lat = 111132.954 - 559.822 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
    m_lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p)
    return m_lat, m_lon


@dataclass(frozen=True)
class WorldFrame:
    lat0: float
    lon0: float

    @property
    def m_lat(self) -> float:
        return metres_per_degree(self.lat0)[0]

    @property
    def m_lon(self) -> float:
        return metres_per_degree(self.lat0)[1]

    # float64 throughout: in float32 a longitude near -156.7 only resolves to about a metre.
    def to_local(self, lon, lat):
        lon, lat = np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64)
        return (lon - self.lon0) * self.m_lon, (lat - self.lat0) * self.m_lat

    def to_lonlat(self, x, y):
        x, y = np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)
        return self.lon0 + x / self.m_lon, self.lat0 + y / self.m_lat


@dataclass(frozen=True)
class Extent:
    min_x: float
    min_y: float
    max_x: float
    max_y: float

    @property
    def width(self) -> float:
        return self.max_x - self.min_x

    @property
    def height(self) -> float:
        return self.max_y - self.min_y

    def as_dict(self) -> dict:
        return {"min_x": self.min_x, "min_y": self.min_y, "max_x": self.max_x, "max_y": self.max_y}


FRAME = WorldFrame(
    lat0=round((AOI.south + AOI.north) / 2, 6), lon0=round((AOI.west + AOI.east) / 2, 6)
)


def _extent() -> Extent:
    x0, y0 = FRAME.to_local(AOI.west, AOI.south)
    x1, y1 = FRAME.to_local(AOI.east, AOI.north)
    # Whole 10 m cells, so the fire grid and the imagery mosaic share edges exactly.
    return Extent(
        math.floor(float(x0) / 10) * 10,
        math.floor(float(y0) / 10) * 10,
        math.ceil(float(x1) / 10) * 10,
        math.ceil(float(y1) / 10) * 10,
    )


EXTENT = _extent()
