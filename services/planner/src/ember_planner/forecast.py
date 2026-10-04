"""The fire spread forecast on the wire: arrival raster, perimeter isochrones and the track."""

from __future__ import annotations

import math

import numpy as np
import shapely

from .grid import BoolArray, Grid, bearing_deg
from .spread import Spread
from .wire import FireIsochrone, FireSpreadForecast, LatLng, PolygonShape, TrackPoint


def forecast(spread: Spread, grid: Grid, band_min: float) -> FireSpreadForecast:
    arrival = spread.arrival
    times = _band_times(spread.horizon_min, band_min)
    isochrones: list[FireIsochrone] = []
    track: list[TrackPoint] = []
    gx, gy = grid.centers()
    for t in times:
        mask = arrival <= t
        if not mask.any():
            continue
        area = float(mask.sum()) * grid.cell_ha
        isochrones.append(
            FireIsochrone(at_min=t, area_ha=round(area, 2), polygons=polygonize(mask, grid))
        )
        cx, cy = float(gx[mask].mean()), float(gy[mask].mean())
        track.append(
            TrackPoint(at_min=t, center=grid.frame.to_latlng(cx, cy), area_ha=round(area, 2))
        )

    heading: float | None = None
    if len(track) >= 2:
        x0, y0 = grid.frame.point(track[0].center)
        x1, y1 = grid.frame.point(track[-1].center)
        if math.hypot(x1 - x0, y1 - y0) >= grid.cell:
            heading = round(bearing_deg(x1 - x0, y1 - y0), 1)

    flat = arrival.ravel()
    return FireSpreadForecast(
        grid=grid.spec(),
        arrival_min=[round(float(v), 1) if math.isfinite(v) else None for v in flat],
        isochrones=isochrones,
        track=track,
        heading_deg=heading,
        max_spread_mpm=round(float(spread.rate.max(initial=0.0)), 2),
    )


def _band_times(horizon: float, band: float) -> list[float]:
    times = [0.0]
    t = band
    while t < horizon - 1e-9:
        times.append(round(t, 3))
        t += band
    times.append(horizon)
    return times


def polygonize(mask: BoolArray, grid: Grid) -> list[PolygonShape]:
    """Cell mask to simplified polygons, merging each row's runs first to keep the union cheap."""
    boxes = []
    for r in range(grid.rows):
        row = np.concatenate(([False], mask[r], [False]))
        edges = np.flatnonzero(row[1:] != row[:-1])
        y0 = grid.y0 + r * grid.cell
        for start, stop in zip(edges[::2], edges[1::2], strict=True):
            x0 = grid.x0 + start * grid.cell
            boxes.append(shapely.box(x0, y0, grid.x0 + stop * grid.cell, y0 + grid.cell))
    if not boxes:
        return []
    # The small buffer joins cells that touch only at a corner, as diagonal spread leaves them.
    merged = (
        shapely.union_all(boxes)
        .buffer(grid.cell * 0.02, join_style="mitre")
        .simplify(grid.cell * 0.3, preserve_topology=True)
    )
    parts = list(getattr(merged, "geoms", [merged]))
    return [_shape(p, grid) for p in parts if not p.is_empty and p.geom_type == "Polygon"]


def _shape(poly: shapely.Polygon, grid: Grid) -> PolygonShape:
    def ring(coords: object) -> list[LatLng]:
        pts = list(shapely.get_coordinates(coords))[:-1]
        return [grid.frame.to_latlng(float(x), float(y)) for x, y in pts]

    return PolygonShape(outer=ring(poly.exterior), holes=[ring(h) for h in poly.interiors])
