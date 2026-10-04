"""Which civilian areas the fire reaches and when, and how each one gets out.

Evacuation is a time-aware search: a node is passable only if the evacuee gets there at least the
safety margin before the fire does, so a route never threads between two fires closing on it.
Nodes the fire reaches soon after the evacuee passes cost more, so routes keep their distance.
"""

from __future__ import annotations

import heapq
import math

import numpy as np
import shapely

from .grid import FloatArray, Grid
from .landscape import Landscape
from .network import Network, mpm, node_fire_times
from .spread import Spread
from .wire import (
    CivilianArea,
    CivilianImpact,
    Destination,
    EvacuationRoute,
    ImpactSeverity,
    LatLng,
    SafeZone,
)

IMMEDIATE_MIN = 60.0
WARNING_MIN = 120.0
# Lead over the fire below which a route starts paying for proximity, up to 3x its travel time.
COMFORT_MIN = 60.0
DRIVEWAY_KMH = 25.0
EXIT_EDGE_CELLS = 2


def civilian_impacts(
    areas: list[CivilianArea], land: Landscape, spread: Spread
) -> list[CivilianImpact]:
    out = []
    for a in areas:
        mask = land.civilian_masks[a.id]
        times = spread.arrival[mask]
        hit = times[np.isfinite(times)]
        impact = float(hit.min()) if hit.size else None
        out.append(
            CivilianImpact(
                civilian_area_id=a.id,
                name=a.name,
                population=a.population,
                impact_min=None if impact is None else round(impact, 1),
                gradient=_gradient(impact, spread.horizon_min),
                exposed_fraction=round(hit.size / times.size, 3) if times.size else 0.0,
                severity=_severity(impact),
            )
        )
    return sorted(out, key=lambda i: math.inf if i.impact_min is None else i.impact_min)


def _gradient(impact: float | None, horizon: float) -> float:
    if impact is None:
        return 0.0
    return round(float(np.clip(1.0 - max(impact, 0.0) / horizon, 0.0, 1.0)), 3)


def _severity(impact: float | None) -> ImpactSeverity:
    if impact is None:
        return "clear"
    if impact <= IMMEDIATE_MIN:
        return "immediate"
    return "warning" if impact <= WARNING_MIN else "watch"


def evacuation_routes(
    areas: list[CivilianArea],
    impacts: list[CivilianImpact],
    land: Landscape,
    spread: Spread,
    net: Network,
    safe_zones: list[SafeZone],
    delay_min: float,
    margin_min: float,
) -> list[EvacuationRoute]:
    g = land.grid
    by_id = {a.id: a for a in areas}
    fire = node_fire_times(net, g, spread.arrival)
    targets = _targets(net, g, fire, safe_zones)
    routes = []
    for impact in impacts:
        if impact.severity == "clear":
            continue
        area = by_id[impact.civilian_area_id]
        x, y = g.frame.point(area.center)
        start, d = net.nearest(x, y)
        t0 = delay_min + d / mpm(DRIVEWAY_KMH)
        routes.append(_route(area.id, net, g, fire, targets, start, t0, margin_min))
    return routes


def _targets(
    net: Network, g: Grid, fire: FloatArray, safe_zones: list[SafeZone]
) -> dict[int, Destination]:
    """Safe zones when the context has them; otherwise ways out of the planning area the fire
    never reaches: road ends at or past its edge, or its edge cells."""
    if safe_zones:
        out: dict[int, Destination] = {}
        for z in safe_zones:
            node, _ = net.nearest(*g.frame.point(z.location))
            out.setdefault(node, Destination(safe_zone_id=z.id, location=z.location))
        return out
    edge = EXIT_EDGE_CELLS * g.cell
    x, y = net.xy[:, 0], net.xy[:, 1]
    near_edge = (
        (x <= g.x0 + edge)
        | (x >= g.x0 + g.cols * g.cell - edge)
        | (y <= g.y0 + edge)
        | (y >= g.y0 + g.rows * g.cell - edge)
    )
    exits = near_edge & ~np.isfinite(fire)
    if net.kind == "roads":
        exits &= np.array([len(a) == 1 for a in net.adj])
    return {
        int(n): Destination(safe_zone_id=None, location=g.frame.to_latlng(*net.xy[n]))
        for n in np.flatnonzero(exits)
    }


def _route(
    area_id: str,
    net: Network,
    g: Grid,
    fire: FloatArray,
    targets: dict[int, Destination],
    start: int,
    t0: float,
    margin: float,
) -> EvacuationRoute:
    none = EvacuationRoute(
        civilian_area_id=area_id,
        status="no_safe_route",
        path=[],
        destination=None,
        distance_m=0.0,
        eta_min=0.0,
        clearance_min=None,
        network=net.kind,
    )
    if not targets or fire[start] - t0 < margin:
        return none
    cost = {start: 0.0}
    time = {start: t0}
    dist = {start: 0.0}
    prev: dict[int, int] = {}
    heap = [(0.0, start)]
    goal = -1
    while heap:
        c, n = heapq.heappop(heap)
        if c > cost[n]:
            continue
        if n in targets:
            goal = n
            break
        for e in net.adj[n]:
            t = time[n] + e.minutes
            slack = fire[e.to] - t
            if slack < margin:
                continue
            nc = c + e.minutes * (1.0 + 2.0 * max(0.0, (COMFORT_MIN - slack) / COMFORT_MIN))
            if nc < cost.get(e.to, math.inf):
                cost[e.to], time[e.to], dist[e.to], prev[e.to] = nc, t, dist[n] + e.length_m, n
                heapq.heappush(heap, (nc, e.to))
    if goal < 0:
        return none

    nodes = [goal]
    while nodes[-1] != start:
        nodes.append(prev[nodes[-1]])
    nodes.reverse()
    leads = [fire[n] - time[n] for n in nodes if math.isfinite(fire[n])]
    clearance = min(leads) if leads else None
    return EvacuationRoute(
        civilian_area_id=area_id,
        status="clear" if clearance is None or clearance >= 2 * margin else "tight",
        path=_path(net, g, nodes),
        destination=targets[goal],
        distance_m=round(dist[goal], 1),
        eta_min=round(time[goal], 1),
        clearance_min=None if clearance is None else round(float(clearance), 1),
        network=net.kind,
    )


def _path(net: Network, g: Grid, nodes: list[int]) -> list[LatLng]:
    pts = net.xy[nodes]
    if len(pts) >= 2:
        tolerance = 1.0 if net.kind == "roads" else g.cell * 0.5
        pts = shapely.get_coordinates(shapely.LineString(pts).simplify(tolerance))
    return [g.frame.to_latlng(float(x), float(y)) for x, y in pts]
