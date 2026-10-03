"""Where each drone of the swarm should go next.

The mapped area is cut into goal tiles about one camera footprint wide. Every drone solves the same
assignment of drones to unfinished tiles (Hungarian algorithm, cost = distance) from the shared
state and flies its own row, so the swarm agrees without a leader. A drone's current tile is
discounted so the assignment holds steady while coverage messages are still in flight.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.optimize import linear_sum_assignment

from ..mapping.grid import MissionGrid

# Tiles with less than this share of their target cells unseen are done.
MIN_REMAINING = 0.12


@dataclass(frozen=True)
class GoalTile:
    id: int
    x: float
    y: float
    remaining: float


@dataclass(frozen=True)
class Agent:
    drone_id: str
    x: float
    y: float
    goal: tuple[float, float] | None


class TilePlan:
    def __init__(self, grid: MissionGrid, tile_m: float) -> None:
        self.grid = grid
        self.k = max(1, round(tile_m / grid.cell_m))
        self.tile_m = self.k * grid.cell_m
        self.tiles_per_side = math.ceil(grid.cols / self.k)

    def tile_id(self, x: float, y: float) -> int | None:
        row, col, ok = self.grid.cells(np.array([x]), np.array([y]))
        if not ok[0]:
            return None
        return int(row[0]) // self.k * self.tiles_per_side + int(col[0]) // self.k

    def open_tiles(self) -> list[GoalTile]:
        g, k, n = self.grid, self.k, self.tiles_per_side
        pad = n * k - g.cols

        def blocks(a: np.ndarray) -> np.ndarray:
            padded = np.pad(a, ((0, pad), (0, pad)))
            summed: np.ndarray = padded.reshape(n, k, n, k).sum(axis=(1, 3))
            return summed

        target = blocks(g.target.astype(np.float64))
        todo_mask = g.target & ~g.observed
        todo = blocks(todo_mask.astype(np.float64))
        sx = blocks(np.where(todo_mask, g.cx, 0.0))
        sy = blocks(np.where(todo_mask, g.cy, 0.0))
        with np.errstate(divide="ignore", invalid="ignore"):
            remaining = np.where(target > 0, todo / target, 0.0)
        # Tiles cut by the boundary count by cells left, not share, or slivers never finish.
        open_ = (target > 0) & (remaining >= MIN_REMAINING) & (todo >= max(2.0, k * k * 0.05))
        out = []
        for r, c in zip(*np.nonzero(open_), strict=True):
            out.append(
                GoalTile(
                    int(r * n + c),
                    float(sx[r, c] / todo[r, c]),
                    float(sy[r, c] / todo[r, c]),
                    float(remaining[r, c]),
                )
            )
        return out


def assign(
    agents: list[Agent],
    tiles: list[GoalTile],
    plan: TilePlan,
    keep_discount_m: float,
) -> dict[str, GoalTile | None]:
    """Each agent's tile, None for agents left over when tiles run out."""
    agents = sorted(agents, key=lambda a: a.drone_id)
    result: dict[str, GoalTile | None] = {a.drone_id: None for a in agents}
    if not agents or not tiles:
        return result
    ax = np.array([a.x for a in agents])[:, None]
    ay = np.array([a.y for a in agents])[:, None]
    tx = np.array([t.x for t in tiles])[None, :]
    ty = np.array([t.y for t in tiles])[None, :]
    cost = np.hypot(ax - tx, ay - ty)
    # Half-finished tiles are slightly cheaper so the swarm does not leave ragged holes behind.
    cost -= np.array([t.remaining < 0.6 for t in tiles])[None, :] * plan.tile_m * 0.25
    index = {t.id: j for j, t in enumerate(tiles)}
    for i, a in enumerate(agents):
        if a.goal is None:
            continue
        tid = plan.tile_id(*a.goal)
        j = None if tid is None else index.get(tid)
        if j is not None:
            cost[i, j] -= keep_discount_m
    rows, cols = linear_sum_assignment(cost)
    for i, j in zip(rows, cols, strict=True):
        result[agents[i].drone_id] = tiles[j]
    return result
