"""Paths over the 2.5D height map.

Altitude follows the terrain: the drone holds its cruise height above the ground and climbs over
anything taller ahead, within the mission's band. Horizontal paths only bend around cells that
would need more than the band allows, or that leave the geofence.
"""

from __future__ import annotations

import heapq
import math

import numpy as np
from numpy.typing import NDArray

from ..geo import FloatArray
from ..mapping.grid import MissionGrid

# A* runs on cells merged up to this many a side, so one search stays under ~15k nodes.
MAX_SEARCH_SIDE = 120


class Terrain:
    def __init__(self, grid: MissionGrid, clearance_m: float, unknown_height_m: float) -> None:
        self.grid = grid
        self.clearance_m = clearance_m
        self.unknown_height_m = unknown_height_m

    def required(self, cruise_agl_m: float) -> tuple[FloatArray, FloatArray]:
        """Ground and the lowest safe flight z per cell when cruising at `cruise_agl_m`."""
        g = self.grid
        ground = np.nan_to_num(g.ground(), nan=0.0)
        heights = g.heights()
        height = np.where(np.isnan(heights), self.unknown_height_m, heights)
        return ground, ground + np.maximum(cruise_agl_m, height + self.clearance_m)

    def blocked(self, cruise_agl_m: float, max_agl_m: float) -> NDArray[np.bool_]:
        ground, need = self.required(cruise_agl_m)
        out: NDArray[np.bool_] = ~self.grid.flyable | (need > ground + max_agl_m)
        return out

    def target_z(
        self,
        pos: FloatArray,
        vel: FloatArray,
        cruise_agl_m: float,
        max_agl_m: float,
        lookahead_s: float,
    ) -> float:
        """Flight z for here: cruise height over the ground below, raised for anything tall
        within the next `lookahead_s` of travel."""
        g = self.grid
        ground, need = self.required(cruise_agl_m)
        steps = np.linspace(0.0, 1.0, 6)[:, None]
        pts = pos[:2] + steps * vel[:2] * lookahead_s
        row, col, ok = g.cells(pts[:, 0], pts[:, 1])
        if not ok[0]:
            return float(pos[2])
        r, c = row[ok], col[ok]
        under = float(ground[row[0], col[0]])
        z = float(need[r, c].max())
        return min(z, under + max_agl_m)


def line_clear(grid: MissionGrid, blocked: NDArray[np.bool_], a: FloatArray, b: FloatArray) -> bool:
    n = max(2, int(math.hypot(b[0] - a[0], b[1] - a[1]) / (grid.cell_m / 2)) + 1)
    t = np.linspace(0.0, 1.0, n)
    row, col, ok = grid.cells(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return bool(ok.all() and not blocked[row, col][1:].any())


def plan(
    grid: MissionGrid, blocked: NDArray[np.bool_], start: FloatArray, goal: FloatArray
) -> list[FloatArray] | None:
    """Horizontal waypoints from start to goal (start excluded), None if the goal is unreachable."""
    if line_clear(grid, blocked, start, goal):
        return [goal[:2].copy()]
    f = max(1, math.ceil(grid.cols / MAX_SEARCH_SIDE))
    n = math.ceil(grid.cols / f)
    pad = n * f - grid.cols
    coarse = (
        np.pad(blocked, ((0, pad), (0, pad)), constant_values=True)
        .reshape(n, f, n, f)
        .any(axis=(1, 3))
    )
    size = grid.cell_m * f

    def node(p: FloatArray) -> tuple[int, int]:
        r, c, _ = grid.cells(np.array([p[0]]), np.array([p[1]]))
        return int(r[0]) // f, int(c[0]) // f

    s, e = node(start), node(goal)
    coarse[s] = False
    if coarse[e]:
        return None
    moves = [(dr, dc, math.hypot(dr, dc)) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc]
    best = {s: 0.0}
    came: dict[tuple[int, int], tuple[int, int]] = {}
    frontier = [(0.0, s)]
    while frontier:
        _, cur = heapq.heappop(frontier)
        if cur == e:
            break
        for dr, dc, step in moves:
            nxt = (cur[0] + dr, cur[1] + dc)
            if not (0 <= nxt[0] < n and 0 <= nxt[1] < n) or coarse[nxt]:
                continue
            # No cutting a corner past a blocked cell.
            if dr and dc and (coarse[cur[0] + dr, cur[1]] or coarse[cur[0], cur[1] + dc]):
                continue
            cost = best[cur] + step
            if cost < best.get(nxt, math.inf):
                best[nxt] = cost
                came[nxt] = cur
                heapq.heappush(frontier, (cost + math.hypot(nxt[0] - e[0], nxt[1] - e[1]), nxt))
    if e not in best:
        return None
    cells = [e]
    while cells[-1] != s:
        cells.append(came[cells[-1]])
    cells.reverse()
    pts = [grid.x0 + (np.array([c, r], dtype=np.float64) + 0.5) * size for r, c in cells[1:-1]]
    pts.append(goal[:2].copy())
    # Shortcut every waypoint the drone can see past.
    out: list[FloatArray] = []
    here = start[:2]
    i = 0
    while i < len(pts):
        j = len(pts) - 1
        while j > i and not line_clear(grid, blocked, here, pts[j]):
            j -= 1
        out.append(pts[j])
        here, i = pts[j], j + 1
    return out
