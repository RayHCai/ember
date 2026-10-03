"""Where to put edge servers (drone docks): greedy maximum coverage.

Candidates sit every 250 m inside the zone. Each round picks the candidate that
covers the most in-zone cells not yet covered, until coverage reaches the
target or the server limit. Candidates near a road (maintenance access) are
preferred: off-road ones score lower but are still allowed.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass

from ..geo.core import LatLon, LocalProjection, bbox, centroid, point_in_polygon, point_segment_distance
from ..geo.grid import ZoneGrid


@dataclass
class EdgeServer:
    id: str
    lat: float
    lon: float
    radius_m: float
    status: str  # "pending" or "deployed"
    near_road: bool = True

    def to_payload(self) -> dict:
        return asdict(self)


class CoverageModel:
    """In-zone cells as bit positions, with fast coverage masks for any point."""

    def __init__(self, grid: ZoneGrid, polygon: Sequence[LatLon]) -> None:
        self.grid = grid
        self.proj = LocalProjection(centroid(polygon))
        self.cells = grid.zone_cells()
        self.xy = [self.proj.to_xy(grid.center(i)) for i in self.cells]
        self.all_mask = (1 << len(self.cells)) - 1
        self._bucket = 500.0
        self._buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
        for bit, (x, y) in enumerate(self.xy):
            self._buckets[(int(x // self._bucket), int(y // self._bucket))].append(bit)

    def mask(self, p: LatLon, radius_m: float) -> int:
        x, y = self.proj.to_xy(p)
        reach = int(math.ceil(radius_m / self._bucket))
        bx, by = int(x // self._bucket), int(y // self._bucket)
        r2 = radius_m * radius_m
        mask = 0
        for i in range(bx - reach, bx + reach + 1):
            for j in range(by - reach, by + reach + 1):
                for bit in self._buckets.get((i, j), ()):
                    cx, cy = self.xy[bit]
                    if (cx - x) ** 2 + (cy - y) ** 2 <= r2:
                        mask |= 1 << bit
        return mask

    def coverage_pct(self, servers: Sequence[EdgeServer]) -> float:
        if not self.cells:
            return 0.0
        covered = 0
        for s in servers:
            covered |= self.mask((s.lat, s.lon), s.radius_m)
        return round(100 * covered.bit_count() / len(self.cells), 1)


class RoadIndex:
    def __init__(self, proj: LocalProjection, roads: Sequence[Sequence[LatLon]], cell_m: float) -> None:
        self.proj = proj
        self.cell = cell_m
        self.buckets: dict[tuple[int, int], list[tuple[tuple[float, float], tuple[float, float]]]] = defaultdict(list)
        for road in roads:
            pts = [proj.to_xy(p) for p in road]
            for a, b in zip(pts, pts[1:]):
                x0, x1 = sorted((a[0], b[0]))
                y0, y1 = sorted((a[1], b[1]))
                for i in range(int(x0 // cell_m), int(x1 // cell_m) + 1):
                    for j in range(int(y0 // cell_m), int(y1 // cell_m) + 1):
                        self.buckets[(i, j)].append((a, b))

    def near(self, p: LatLon, within_m: float) -> bool:
        x, y = self.proj.to_xy(p)
        bx, by = int(x // self.cell), int(y // self.cell)
        for i in (bx - 1, bx, bx + 1):
            for j in (by - 1, by, by + 1):
                for a, b in self.buckets.get((i, j), ()):
                    if point_segment_distance((x, y), a, b) <= within_m:
                        return True
        return False


def candidate_points(polygon: Sequence[LatLon], spacing_m: float) -> list[LatLon]:
    s, w, n, e = bbox(polygon)
    proj = LocalProjection((s, w))
    width, height = proj.to_xy((s, e))[0], proj.to_xy((n, w))[1]
    points = []
    y = spacing_m / 2
    while y < height:
        x = spacing_m / 2
        while x < width:
            p = proj.to_latlon(x, y)
            if point_in_polygon(p, polygon):
                points.append(p)
            x += spacing_m
        y += spacing_m
    return points


def plan_edge_servers(
    grid: ZoneGrid,
    polygon: Sequence[LatLon],
    roads: Sequence[Sequence[LatLon]],
    *,
    radius_m: float,
    spacing_m: float,
    road_access_m: float,
    off_road_weight: float,
    target: float,
    max_servers: int,
) -> tuple[list[EdgeServer], float]:
    model = CoverageModel(grid, polygon)
    if not model.cells:
        return [], 0.0
    road_index = RoadIndex(model.proj, roads, max(road_access_m, 100.0))
    candidates = candidate_points(polygon, spacing_m) or [centroid(polygon)]
    masks = [model.mask(p, radius_m) for p in candidates]
    near_road = [road_index.near(p, road_access_m) for p in candidates]

    chosen: list[EdgeServer] = []
    uncovered = model.all_mask
    total = len(model.cells)
    while len(chosen) < max_servers and 1 - uncovered.bit_count() / total < target:
        best, best_score = -1, 0.0
        for k, mask in enumerate(masks):
            gain = (mask & uncovered).bit_count()
            score = gain * (1.0 if near_road[k] else off_road_weight)
            if score > best_score:
                best, best_score = k, score
        if best < 0:
            break
        lat, lon = candidates[best]
        chosen.append(EdgeServer(f"edge-{len(chosen) + 1}", lat, lon, radius_m, "pending", near_road[best]))
        uncovered &= ~masks[best]
    return chosen, model.coverage_pct(chosen)
