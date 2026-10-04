"""Local metric frame around a point, and planar polygon helpers.

The mission frame is metres east (x), north (y) and up (z) of the edge server's ground position.
Over a connectivity radius of a few kilometres a tangent plane is accurate to centimetres
horizontally, so no projection library is needed on the drone.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike, NDArray

WGS84_A = 6378137.0
WGS84_E2 = 6.69437999014e-3

FloatArray = NDArray[np.float64]


@dataclass(frozen=True)
class LatLng:
    lat: float
    lng: float


class LocalFrame:
    def __init__(self, origin: LatLng) -> None:
        self.origin = origin
        phi = math.radians(origin.lat)
        w = 1.0 - WGS84_E2 * math.sin(phi) ** 2
        meridian = WGS84_A * (1.0 - WGS84_E2) / w**1.5
        normal = WGS84_A / math.sqrt(w)
        self.m_per_deg_lat = math.radians(1.0) * meridian
        self.m_per_deg_lng = math.radians(1.0) * normal * math.cos(phi)

    def to_xy(self, lat: ArrayLike, lng: ArrayLike) -> tuple[FloatArray, FloatArray]:
        x = (np.asarray(lng, dtype=np.float64) - self.origin.lng) * self.m_per_deg_lng
        y = (np.asarray(lat, dtype=np.float64) - self.origin.lat) * self.m_per_deg_lat
        return x, y

    def to_latlng(self, x: ArrayLike, y: ArrayLike) -> tuple[FloatArray, FloatArray]:
        lat = self.origin.lat + np.asarray(y, dtype=np.float64) / self.m_per_deg_lat
        lng = self.origin.lng + np.asarray(x, dtype=np.float64) / self.m_per_deg_lng
        return lat, lng

    def point(self, p: LatLng) -> tuple[float, float]:
        return self.point_xy(p.lat, p.lng)

    def point_xy(self, lat: float, lng: float) -> tuple[float, float]:
        x, y = self.to_xy(lat, lng)
        return float(x), float(y)

    def latlng(self, x: float, y: float) -> LatLng:
        lat, lng = self.to_latlng(x, y)
        return LatLng(float(lat), float(lng))


def inside_polygon(x: FloatArray, y: FloatArray, polygon: FloatArray) -> NDArray[np.bool_]:
    """Even-odd test of points against one ring of (n, 2) vertices, open or closed."""
    inside = np.zeros(np.broadcast(x, y).shape, dtype=bool)
    px, py = polygon[:, 0], polygon[:, 1]
    qx, qy = np.roll(px, -1), np.roll(py, -1)
    for x0, y0, x1, y1 in zip(px, py, qx, qy, strict=True):
        if y0 == y1:
            continue
        crosses = (y0 > y) != (y1 > y)
        x_at = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        inside ^= crosses & (x < x_at)
    return inside


def polygon_area(polygon: FloatArray) -> float:
    x, y = polygon[:, 0], polygon[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def polygon_centroid(polygon: FloatArray) -> FloatArray:
    """Area centroid of one ring; the vertex mean when the ring has no area."""
    x, y = polygon[:, 0], polygon[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    cross = x * yn - xn * y
    area = cross.sum() / 2
    if abs(area) < 1e-9:
        mean: FloatArray = polygon.mean(axis=0)
        return mean
    return np.array([((x + xn) * cross).sum() / (6 * area), ((y + yn) * cross).sum() / (6 * area)])
