"""Travel networks: the context's roads, or the planning grid itself when there are none."""

from __future__ import annotations

import heapq
import itertools
import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

import numpy as np
import shapely
from scipy.spatial import cKDTree

from .grid import FloatArray, Grid, LocalFrame
from .wire import Road, RoadKind

# Evacuation speeds, below limits: traffic and smoke.
ROAD_SPEED_KMH: dict[RoadKind, float] = {
    "motorway": 60.0,
    "primary": 45.0,
    "secondary": 40.0,
    "residential": 25.0,
    "track": 15.0,
}
TERRAIN_SPEED_KMH = 15.0
# Walking pace with gear, for the stretch between a road and a point off it.
FOOT_SPEED_MPM = 50.0
# Road points closer than this are one junction.
SNAP_M = 3.0
UNCERTAIN_SPEED_FACTOR = 0.5


def mpm(kmh: float) -> float:
    return kmh * 1000.0 / 60.0


@dataclass(frozen=True)
class Edge:
    to: int
    length_m: float
    minutes: float
    road: str | None = None


@dataclass
class Network:
    kind: Literal["roads", "terrain"]
    xy: FloatArray
    adj: list[list[Edge]]

    def __post_init__(self) -> None:
        self._tree = cKDTree(self.xy)

    @property
    def size(self) -> int:
        return len(self.adj)

    def nearest(self, x: float, y: float) -> tuple[int, float]:
        dist, idx = self._tree.query([x, y])
        return int(idx), float(dist)

    def nearest_many(self, xs: FloatArray, ys: FloatArray) -> tuple[np.ndarray, FloatArray]:
        dist, idx = self._tree.query(np.column_stack([xs.ravel(), ys.ravel()]))
        return np.asarray(idx, dtype=np.int64), np.asarray(dist, dtype=np.float64)


def road_network(roads: Iterable[Road], frame: LocalFrame, max_segment_m: float) -> Network | None:
    """Roads densified to `max_segment_m` so the fire is sampled along every stretch, and split
    where they cross or where one ends on another, so those points join the two."""
    road_list = [r for r in roads if r.state != "blocked"]
    lines = [shapely.LineString(frame.ring(r.path)) for r in road_list]
    index: dict[tuple[int, int], int] = {}
    xy: list[tuple[float, float]] = []
    adj: list[list[Edge]] = []

    def node(x: float, y: float) -> int:
        kx, ky = round(x), round(y)
        for key in ((kx + i, ky + j) for i in (0, -1, 1) for j in (0, -1, 1)):
            n = index.get(key)
            if n is not None and math.dist(xy[n], (x, y)) <= SNAP_M:
                return n
        index[(kx, ky)] = len(xy)
        xy.append((x, y))
        adj.append([])
        return len(xy) - 1

    def link(a: int, b: int, speed: float, road: str) -> None:
        if a == b:
            return
        length = math.dist(xy[a], xy[b])
        adj[a].append(Edge(b, length, length / speed, road))
        adj[b].append(Edge(a, length, length / speed, road))

    for road, line, cuts in zip(road_list, lines, _junctions(lines), strict=True):
        speed = mpm(ROAD_SPEED_KMH[road.kind])
        if road.state == "uncertain":
            speed *= UNCERTAIN_SPEED_FACTOR
        vertices = [line.project(shapely.Point(p)) for p in line.coords]
        stops = sorted({*vertices, *cuts})
        prev = node(*line.coords[0])
        for d0, d1 in itertools.pairwise(stops):
            steps = max(1, math.ceil((d1 - d0) / max_segment_m))
            for k in range(1, steps + 1):
                p = line.interpolate(d0 + (d1 - d0) * k / steps)
                cur = node(p.x, p.y)
                link(prev, cur, speed, road.id)
                prev = cur
    if not xy:
        return None
    return Network("roads", np.array(xy, dtype=np.float64), adj)


def _junctions(lines: list[shapely.LineString]) -> list[list[float]]:
    """For each line, distances along it where another line crosses it or ends within `SNAP_M`."""
    tree = shapely.STRtree(lines)
    out: list[list[float]] = []
    for i, line in enumerate(lines):
        cuts: list[float] = []
        for j in tree.query(line.buffer(SNAP_M)).tolist():
            if j == i:
                continue
            other = lines[j]
            for p in shapely.get_coordinates(line.intersection(other)):
                cuts.append(line.project(shapely.Point(p)))
            for end in (other.coords[0], other.coords[-1]):
                pt = shapely.Point(end)
                if line.distance(pt) <= SNAP_M:
                    cuts.append(line.project(pt))
        out.append(cuts)
    return out


def terrain_network(grid: Grid) -> Network:
    """Every cell centre, joined to its 8 neighbours at cross-country speed."""
    speed = mpm(TERRAIN_SPEED_KMH)
    gx, gy = grid.centers()
    adj: list[list[Edge]] = [[] for _ in range(grid.size)]
    for r in range(grid.rows):
        for c in range(grid.cols):
            i = r * grid.cols + c
            for dr, dc in ((0, 1), (1, -1), (1, 0), (1, 1)):
                r2, c2 = r + dr, c + dc
                if 0 <= r2 < grid.rows and 0 <= c2 < grid.cols:
                    j = r2 * grid.cols + c2
                    length = grid.cell * math.hypot(dr, dc)
                    adj[i].append(Edge(j, length, length / speed))
                    adj[j].append(Edge(i, length, length / speed))
    return Network("terrain", np.column_stack([gx.ravel(), gy.ravel()]), adj)


def node_fire_times(net: Network, grid: Grid, arrival: FloatArray) -> FloatArray:
    """When the fire reaches each node; inf off the grid or beyond the horizon."""
    r, c, inside = grid.cell_of(net.xy[:, 0], net.xy[:, 1])
    return np.where(inside, arrival[r, c], np.inf)


@dataclass(frozen=True)
class TravelTree:
    """Fastest times from the sources and how each node was reached; -1 marks a source."""

    minutes: FloatArray
    pred: list[int]
    origin: list[int]
    via: list[str | None]

    def walk_back(self, node: int) -> list[int]:
        nodes = [node]
        while self.pred[nodes[-1]] >= 0:
            nodes.append(self.pred[nodes[-1]])
        nodes.reverse()
        return nodes


def travel_tree(net: Network, sources: dict[int, float]) -> TravelTree:
    best = np.full(net.size, np.inf)
    pred = [-1] * net.size
    origin = list(range(net.size))
    via: list[str | None] = [None] * net.size
    for n, t in sources.items():
        best[n] = min(best[n], t)
    heap = [(float(best[n]), n) for n in sources]
    heapq.heapify(heap)
    while heap:
        t, n = heapq.heappop(heap)
        if t > best[n]:
            continue
        for e in net.adj[n]:
            nt = t + e.minutes
            if nt < best[e.to]:
                best[e.to] = nt
                pred[e.to], origin[e.to], via[e.to] = n, origin[n], e.road
                heapq.heappush(heap, (nt, e.to))
    return TravelTree(best, pred, origin, via)


def travel_minutes(net: Network, sources: dict[int, float]) -> FloatArray:
    """Fastest time to every node from any source, each starting at its given minute."""
    return travel_tree(net, sources).minutes


def distinct_roads(via: Iterable[str | None]) -> list[str]:
    """Road ids in first-use order, without repeats."""
    return list(dict.fromkeys(r for r in via if r is not None))
