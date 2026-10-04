"""Where responders should fight the fire.

The spread forecast is a tree: every reached cell was reached from one parent. Holding the fire
at a cell protects its whole subtree, so a cell's value is everything downstream of it (area, with
people weighted far above forest). Candidates must be reachable before the fire arrives, and slow
fronts score above fast ones, which are unsafe to work. The best cells, kept apart by a minimum
separation, become the attack zones.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import shapely

from .grid import FloatArray, Grid, bearing_deg
from .landscape import Landscape
from .network import FOOT_SPEED_MPM, Network, TravelTree, distinct_roads, mpm, travel_tree
from .spread import Spread
from .wire import AttackApproach, AttackZone, LatLng, ResponderStation

SETUP_MIN = 15.0
DIRECT_ATTACK_MAX_MPM = 10.0
PERSON_WEIGHT_HA = 5.0
MIN_SEPARATION_M = 400.0
MIN_RADIUS_M = 75.0
# Zones scoring below this share of the best one are not worth a crew.
MIN_RELATIVE_SCORE = 0.1
MAX_DROP_DISTANCE_M = 2000.0
# Without roads, crews drive cross-country at this speed over a path this much longer than straight.
OFFROAD_KMH = 30.0
TORTUOSITY = 1.4


def attack_zones(
    land: Landscape,
    spread: Spread,
    roads: Network | None,
    stations: list[ResponderStation],
    count: int,
) -> list[AttackZone]:
    g = land.grid
    arrival = spread.arrival.ravel()
    reached = np.flatnonzero(np.isfinite(arrival))
    if count == 0 or reached.size == 0:
        return []
    order = reached[np.argsort(arrival[reached], kind="stable")]
    parent = spread.parent
    population = land.population.ravel()
    value = g.cell_ha + PERSON_WEIGHT_HA * population
    downstream = value.copy()
    parent_list = parent.tolist()
    for c in reversed(order.tolist()):
        p = parent_list[c]
        if p >= 0:
            downstream[p] += downstream[c]

    crews = _road_crews(g, roads, stations)
    access = _access_minutes(land, roads, stations, crews)
    lead = (access if access is not None else np.zeros(g.size)) + SETUP_MIN
    rate = spread.rate.ravel()
    burnable = land.base_ros.ravel() > 0
    ok = np.isfinite(arrival) & (parent >= 0) & burnable & (arrival >= lead)
    with np.errstate(invalid="ignore"):
        slack = np.nan_to_num(np.clip((arrival - lead) / 60.0, 0.0, 1.0))
    score = np.where(
        ok, downstream / (1.0 + rate / DIRECT_ATTACK_MAX_MPM) * (0.5 + 0.5 * slack), 0.0
    )
    gx, gy = (a.ravel() for a in g.centers())
    separation = max(MIN_SEPARATION_M, 6 * g.cell)

    picks: list[int] = []
    for c in np.argsort(-score, kind="stable").tolist():
        if score[c] <= 0 or len(picks) == count:
            break
        if picks and score[c] < MIN_RELATIVE_SCORE * score[picks[0]]:
            break
        if all(math.hypot(gx[c] - gx[p], gy[c] - gy[p]) >= separation for p in picks):
            picks.append(c)
    if not picks:
        return []

    radii = []
    for c in picks:
        near = (gx - gx[c]) ** 2 + (gy - gy[c]) ** 2 <= separation**2
        cells = int((near & (score >= 0.5 * score[c])).sum())
        radii.append(
            float(np.clip(math.sqrt(cells / math.pi) * g.cell, MIN_RADIUS_M, separation / 2))
        )

    zone_of = _held_by(picks, radii, gx, gy, order, parent_list, g.size)
    top = score[picks[0]]
    zones = []
    for k, (c, radius) in enumerate(zip(picks, radii, strict=True)):
        held = zone_of == k
        protects = [aid for aid, m in land.civilian_masks.items() if (held & m.ravel()).any()]
        drop = (float(gx[c]), float(gy[c]))
        drop_node = None
        if roads is not None:
            drop_node, d = roads.nearest(*drop)
            if d <= MAX_DROP_DISTANCE_M:
                drop = (float(roads.xy[drop_node, 0]), float(roads.xy[drop_node, 1]))
        zones.append(
            AttackZone(
                id=f"attack-{k + 1}",
                rank=k + 1,
                center=g.frame.to_latlng(float(gx[c]), float(gy[c])),
                radius_m=round(radius, 1),
                drop_site=g.frame.to_latlng(*drop),
                score=round(float(score[c] / top), 3),
                fire_arrival_min=round(float(arrival[c]), 1),
                access_min=None if access is None else round(float(access[c]), 1),
                spread_rate_mpm=round(float(rate[c]), 2),
                tactic="direct" if rate[c] <= DIRECT_ATTACK_MAX_MPM else "indirect",
                protects=protects,
                protected_population=round(float(population[held].sum()), 1),
                protected_area_ha=round(float(held.sum()) * g.cell_ha, 2),
                approach=_approach(g, roads, crews, drop_node),
            )
        )
    return zones


@dataclass(frozen=True)
class _Crews:
    tree: TravelTree
    station_at: dict[int, ResponderStation]


def _road_crews(g: Grid, roads: Network | None, stations: list[ResponderStation]) -> _Crews | None:
    """Fastest road travel from the stations; each walks to its nearest road node first."""
    if roads is None or not stations:
        return None
    sources: dict[int, float] = {}
    station_at: dict[int, ResponderStation] = {}
    for s in stations:
        node, d = roads.nearest(*g.frame.point(s.location))
        t = d / FOOT_SPEED_MPM
        if t < sources.get(node, math.inf):
            sources[node], station_at[node] = t, s
    return _Crews(travel_tree(roads, sources), station_at)


def _access_minutes(
    land: Landscape,
    roads: Network | None,
    stations: list[ResponderStation],
    crews: _Crews | None,
) -> FloatArray | None:
    """Minutes from the nearest station to each cell; None when there are no stations."""
    if not stations:
        return None
    g = land.grid
    gx, gy = g.centers()
    if roads is None or crews is None:
        best = np.full(g.size, np.inf)
        for st in stations:
            x, y = g.frame.point(st.location)
            path_m = np.hypot(gx - x, gy - y).ravel() * TORTUOSITY
            best = np.minimum(best, path_m / mpm(OFFROAD_KMH))
        return best
    idx, dist = roads.nearest_many(gx, gy)
    return np.asarray(crews.tree.minutes[idx] + dist / FOOT_SPEED_MPM, dtype=np.float64)


def _approach(
    g: Grid, roads: Network | None, crews: _Crews | None, drop_node: int | None
) -> AttackApproach | None:
    if roads is None or crews is None or drop_node is None:
        return None
    tree = crews.tree
    eta = float(tree.minutes[drop_node])
    if not math.isfinite(eta):
        return None
    nodes = tree.walk_back(drop_node)
    station = crews.station_at[tree.origin[drop_node]]
    pts = np.vstack([[g.frame.point(station.location)], roads.xy[nodes]])
    pts = shapely.get_coordinates(shapely.LineString(pts).simplify(1.0)) if len(pts) >= 2 else pts
    path = [g.frame.to_latlng(float(x), float(y)) for x, y in pts]
    return AttackApproach(
        station_id=station.id,
        path=path,
        road_ids=distinct_roads(tree.via[n] for n in nodes[1:]),
        eta_min=round(eta, 1),
        arrives_from_deg=_arrives_from(g, path),
    )


def _arrives_from(g: Grid, path: list[LatLng]) -> float | None:
    """Bearing from the drop site toward the previous distinct point of the path."""
    x1, y1 = g.frame.point(path[-1])
    for p in reversed(path[:-1]):
        x0, y0 = g.frame.point(p)
        if (x0, y0) != (x1, y1):
            return round(bearing_deg(x0 - x1, y0 - y1), 1) % 360.0
    return None


def _held_by(
    picks: list[int],
    radii: list[float],
    gx: FloatArray,
    gy: FloatArray,
    order: np.ndarray,
    parent: list[int],
    n: int,
) -> np.ndarray:
    """For each cell, the zone that stops the fire before it gets there; -1 for none. Cells inside
    a zone are where the fight happens, so they count for no zone."""
    disk = np.full(n, -1, dtype=np.int64)
    for k in reversed(range(len(picks))):
        c = picks[k]
        disk[(gx - gx[c]) ** 2 + (gy - gy[c]) ** 2 <= radii[k] ** 2] = k
    disk_list = disk.tolist()
    held = [-1] * n
    for c in order.tolist():
        p = parent[c]
        if p < 0:
            continue
        held[c] = disk_list[p] if disk_list[p] >= 0 else held[p]
    out = np.array(held, dtype=np.int64)
    out[disk >= 0] = -1
    return out
