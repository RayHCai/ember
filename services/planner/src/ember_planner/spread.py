"""Fire spread as minimum travel time over the planning grid.

Each cell connects to its 16 neighbours (kings and knights moves, which keeps fronts from
squaring off). Spread into a neighbour runs at the neighbour's base rate scaled by dryness, by an
elliptical wind factor and by slope, the same factor shapes Rothermel's model uses. One Dijkstra
from a virtual source, linked to each ignited cell with its burn age, gives every cell's arrival
time and the cell the fire reached it from. It is a fast screening model, not a calibrated one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from .grid import FloatArray, IntArray
from .landscape import MAX_IGNITION_AGE_MIN, Landscape

NEIGHBOURS: tuple[tuple[int, int], ...] = (
    (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1),
    (1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2),
)  # fmt: skip
MAX_LENGTH_TO_BREADTH = 8.0
MAX_SLOPE_FACTOR = 10.0
# Keeps the virtual source's edge to the oldest ignition from being a zero, which csgraph drops.
_EPS = 1e-6


@dataclass(frozen=True)
class Spread:
    # Minutes after the plan the fire reaches each cell; negative before it, inf beyond horizon.
    arrival: FloatArray
    # Flat index of the cell the fire came from; -1 for ignitions and unreached cells.
    parent: IntArray
    # Speed of the front as it entered each cell, metres per minute.
    rate: FloatArray
    horizon_min: float

    @property
    def reached(self) -> np.ndarray:
        return np.isfinite(self.arrival)


def wind_head_factor(speed_mps: float) -> float:
    return 1.0 + 0.35 * float(speed_mps**1.5)


def wind_eccentricity(speed_mps: float) -> float:
    lb = min(1.0 + 0.25 * speed_mps, MAX_LENGTH_TO_BREADTH)
    return math.sqrt(1.0 - 1.0 / (lb * lb))


def slope_factor(tan: FloatArray) -> FloatArray:
    up = np.minimum(np.exp(3.533 * np.abs(tan) ** 1.2), MAX_SLOPE_FACTOR)
    down = np.maximum(np.exp(-0.7 * np.abs(tan)), 0.5)
    return np.asarray(np.where(tan > 0, up, down), dtype=np.float64)


def simulate(land: Landscape, horizon_min: float) -> Spread:
    g = land.grid
    n = g.size
    shape = (g.rows, g.cols)
    if not land.ignitions:
        return Spread(
            np.full(shape, np.inf), np.full(n, -1, dtype=np.int64), np.zeros(shape), horizon_min
        )

    ros = land.base_ros * land.dryness
    head = wind_head_factor(land.wind.speed_mps)
    ecc = wind_eccentricity(land.wind.speed_mps)
    wx, wy = land.wind.toward
    rr, cc = np.indices(shape)
    src_parts: list[np.ndarray] = []
    dst_parts: list[np.ndarray] = []
    weight_parts: list[np.ndarray] = []

    for dr, dc in NEIGHBOURS:
        r2, c2 = rr + dr, cc + dc
        ok = (r2 >= 0) & (r2 < g.rows) & (c2 >= 0) & (c2 < g.cols)
        sr, sc, tr, tc = rr[ok], cc[ok], r2[ok], c2[ok]
        rate = ros[tr, tc]
        for ir, ic in _crossed(dr, dc):
            rate = np.where(ros[sr + ir, sc + ic] > 0, rate, 0.0)
        hyp = math.hypot(dr, dc)
        dist = g.cell * hyp
        cos_t = (dc * wx + dr * wy) / hyp
        rate = rate * head * (1.0 - ecc) / (1.0 - ecc * cos_t)
        rate = rate * slope_factor((land.elevation[tr, tc] - land.elevation[sr, sc]) / dist)
        keep = rate > 0
        src_parts.append((sr * g.cols + sc)[keep])
        dst_parts.append((tr * g.cols + tc)[keep])
        weight_parts.append(dist / rate[keep])

    cells = np.fromiter(land.ignitions.keys(), dtype=np.int64)
    ages = np.fromiter(land.ignitions.values(), dtype=np.float64)
    src_parts.append(np.full(cells.size, n, dtype=np.int64))
    dst_parts.append(cells)
    weight_parts.append(MAX_IGNITION_AGE_MIN - ages + _EPS)

    graph = csr_matrix(
        (np.concatenate(weight_parts), (np.concatenate(src_parts), np.concatenate(dst_parts))),
        shape=(n + 1, n + 1),
    )
    offset = MAX_IGNITION_AGE_MIN + _EPS
    dist_all, pred = dijkstra(
        graph, directed=True, indices=n, return_predecessors=True, limit=horizon_min + offset
    )
    arrival = np.asarray(dist_all[:n], dtype=np.float64) - offset
    arrival[arrival > horizon_min] = np.inf
    parent = np.asarray(pred[:n], dtype=np.int64)
    parent[(parent < 0) | (parent == n) | ~np.isfinite(arrival)] = -1

    rate_in = np.zeros(n)
    child = np.flatnonzero(parent >= 0)
    par = parent[child]
    step = g.cell * np.hypot(child // g.cols - par // g.cols, child % g.cols - par % g.cols)
    dt = np.maximum(arrival.ravel()[child] - arrival.ravel()[par], 1e-9)
    rate_in[child] = step / dt
    return Spread(arrival.reshape(shape), parent, rate_in.reshape(shape), horizon_min)


def _crossed(dr: int, dc: int) -> tuple[tuple[int, int], ...]:
    """Cells a knight's move passes between; it may not jump a fuel break."""
    if abs(dr) + abs(dc) != 3:
        return ()
    sr, sc = int(math.copysign(1, dr)), int(math.copysign(1, dc))
    if abs(dc) == 2:
        return ((0, sc), (dr, sc))
    return ((sr, 0), (sr, dc))
