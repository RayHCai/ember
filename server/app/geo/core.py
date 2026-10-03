"""Small-area geometry on lat/lon. Accurate to well under a percent for zones of
a few tens of kilometres, which is all Ember needs."""

from __future__ import annotations

import math
from collections.abc import Sequence

LatLon = tuple[float, float]

EARTH_RADIUS_M = 6_371_008.8
METERS_PER_DEG_LAT = 111_320.0


def meters_per_deg_lon(lat: float) -> float:
    return METERS_PER_DEG_LAT * math.cos(math.radians(lat))


def haversine_m(a: LatLon, b: LatLon) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


class LocalProjection:
    """Equirectangular projection to metres around a reference point."""

    def __init__(self, ref: LatLon) -> None:
        self.lat0, self.lon0 = ref
        self.kx = meters_per_deg_lon(self.lat0)

    def to_xy(self, p: LatLon) -> tuple[float, float]:
        return ((p[1] - self.lon0) * self.kx, (p[0] - self.lat0) * METERS_PER_DEG_LAT)

    def to_latlon(self, x: float, y: float) -> LatLon:
        return (self.lat0 + y / METERS_PER_DEG_LAT, self.lon0 + x / self.kx)


def centroid(points: Sequence[LatLon]) -> LatLon:
    n = len(points)
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)


def bbox(points: Sequence[LatLon]) -> tuple[float, float, float, float]:
    """(south, west, north, east)"""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return (min(lats), min(lons), max(lats), max(lons))


def expand_bbox(b: tuple[float, float, float, float], margin_m: float) -> tuple[float, float, float, float]:
    s, w, n, e = b
    dlat = margin_m / METERS_PER_DEG_LAT
    dlon = margin_m / meters_per_deg_lon((s + n) / 2)
    return (s - dlat, w - dlon, n + dlat, e + dlon)


def point_in_polygon(p: LatLon, polygon: Sequence[LatLon]) -> bool:
    """Ray casting. The polygon may be open or closed."""
    lat, lon = p
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        lat_i, lon_i = polygon[i]
        lat_j, lon_j = polygon[j]
        if (lat_i > lat) != (lat_j > lat):
            cross_lon = lon_i + (lat - lat_i) * (lon_j - lon_i) / (lat_j - lat_i)
            if lon < cross_lon:
                inside = not inside
        j = i
    return inside


def polygon_area_km2(polygon: Sequence[LatLon]) -> float:
    proj = LocalProjection(centroid(polygon))
    xy = [proj.to_xy(p) for p in polygon]
    area = 0.0
    for i in range(len(xy)):
        x1, y1 = xy[i]
        x2, y2 = xy[(i + 1) % len(xy)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2 / 1e6


def segments_intersect(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float], d: tuple[float, float]) -> bool:
    def orient(p, q, r) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return (o1 * o2 < 0) and (o3 * o4 < 0)


def is_simple_polygon(polygon: Sequence[LatLon]) -> bool:
    """False if any two non-adjacent edges cross."""
    n = len(polygon)
    edges = [(polygon[i], polygon[(i + 1) % n]) for i in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if j == i + 1 or (i == 0 and j == n - 1):
                continue
            if segments_intersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1]):
                return False
    return True


def point_segment_distance(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in the plane, for projected coordinates."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(points: Sequence[LatLon], tolerance_m: float) -> list[LatLon]:
    """Douglas-Peucker on a polyline."""
    if len(points) < 3:
        return list(points)
    proj = LocalProjection(points[0])
    xy = [proj.to_xy(p) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        best, index = 0.0, -1
        for i in range(start + 1, end):
            d = point_segment_distance(xy[i], xy[start], xy[end])
            if d > best:
                best, index = d, i
        if best > tolerance_m and index > 0:
            keep[index] = True
            stack.append((start, index))
            stack.append((index, end))
    return [p for p, k in zip(points, keep) if k]
