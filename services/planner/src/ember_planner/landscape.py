"""Turns a `PlannerContext` into rasters on one planning grid: fuel, elevation, risk, ignitions,
civilian areas. Every default the context forces is recorded as an assumption."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np

from .grid import BoolArray, FloatArray, Grid, LocalFrame, fit_grid
from .wire import FuelType, LatLng, PlannerContext, TerrainGrid

# Rate of spread with no wind, on flat ground, at nominal dryness. Grass, shrub and timber follow
# the Anderson fuel-model groups; urban is structure-to-structure spread.
BASE_ROS_MPM: dict[FuelType, float] = {
    "none": 0.0,
    "grass": 3.0,
    "shrub": 1.6,
    "timber": 0.8,
    "urban": 0.6,
}
AT_RISK_ROS_FACTOR = 1.5
MIN_DETECTION_CONFIDENCE = 0.4
MAX_IGNITION_AGE_MIN = 60.0
POINT_AREA_RADIUS_M = 150.0
DEFAULT_TEMPERATURE_C = 25.0
DEFAULT_HUMIDITY_PCT = 30.0


@dataclass(frozen=True)
class Wind:
    speed_mps: float
    # Unit vector the wind blows toward, east and north.
    toward: tuple[float, float]


@dataclass
class Landscape:
    grid: Grid
    base_ros: FloatArray
    fuel: np.ndarray
    elevation: FloatArray
    zone: BoolArray
    at_risk: BoolArray
    # Minutes each ignited cell has burnt before the plan, keyed by flat cell index.
    ignitions: dict[int, float]
    wind: Wind
    dryness: float
    population: FloatArray
    civilian_masks: dict[str, BoolArray]
    assumptions: list[str] = field(default_factory=list)


def build_landscape(
    ctx: PlannerContext,
    now: datetime,
    *,
    margin_m: float = 1500.0,
    min_cell_m: float = 30.0,
    max_cells: int = 40_000,
) -> Landscape:
    frame = LocalFrame(_centroid(ctx.boundary))
    min_cell = max(min_cell_m, ctx.terrain.cell_size_m if ctx.terrain else 0.0)
    grid = fit_grid(frame, _extent_points(ctx, frame), margin_m, min_cell, max_cells)
    assumptions: list[str] = []

    zone = grid.polygon_mask(ctx.boundary)
    civilian_masks = {
        a.id: grid.polygon_mask(a.polygon)
        if a.polygon and len(a.polygon) >= 3
        else grid.disk_mask(*frame.point(a.center), POINT_AREA_RADIUS_M)
        for a in ctx.civilian_areas
    }
    elevation, fuel = _terrain(grid, ctx.terrain, zone, civilian_masks, assumptions)

    base_ros = np.vectorize(BASE_ROS_MPM.__getitem__, otypes=[np.float64])(fuel)
    at_risk = np.zeros((grid.rows, grid.cols), dtype=np.bool_)
    for z in ctx.risk_zones:
        if z.risk == "at_risk":
            at_risk |= grid.polygon_mask(z.polygon)
    for d in ctx.detections:
        if d.risk == "at_risk" and d.confidence >= MIN_DETECTION_CONFIDENCE:
            at_risk |= _detection_mask(grid, d.ground, d.center)
    base_ros = np.where(at_risk, base_ros * AT_RISK_ROS_FACTOR, base_ros)

    population = np.zeros((grid.rows, grid.cols), dtype=np.float64)
    for a in ctx.civilian_areas:
        mask = civilian_masks[a.id]
        if mask.any():
            population[mask] += a.population / int(mask.sum())

    wind, dryness = _weather(ctx, assumptions)
    ignitions = _ignitions(ctx, grid, now, at_risk, assumptions)
    return Landscape(
        grid=grid,
        base_ros=base_ros,
        fuel=fuel,
        elevation=elevation,
        zone=zone,
        at_risk=at_risk,
        ignitions=ignitions,
        wind=wind,
        dryness=dryness,
        population=population,
        civilian_masks=civilian_masks,
        assumptions=assumptions,
    )


def _centroid(ring: list[LatLng]) -> LatLng:
    return LatLng(
        lat=sum(p.lat for p in ring) / len(ring), lng=sum(p.lng for p in ring) / len(ring)
    )


def _extent_points(ctx: PlannerContext, frame: LocalFrame) -> FloatArray:
    pts: list[LatLng] = list(ctx.boundary)
    for z in ctx.risk_zones:
        pts.extend(z.polygon)
    for d in ctx.detections:
        pts.extend([d.center, *d.ground])
    for a in ctx.civilian_areas:
        pts.extend([a.center, *(a.polygon or [])])
    pts.extend(s.location for s in ctx.safe_zones)
    pts.extend(s.location for s in ctx.stations)
    return frame.ring(pts)


def _terrain(
    grid: Grid,
    terrain: TerrainGrid | None,
    zone: BoolArray,
    civilian_masks: dict[str, BoolArray],
    assumptions: list[str],
) -> tuple[FloatArray, np.ndarray]:
    default_fuel = np.where(zone, "timber", "shrub").astype(object)
    for mask in civilian_masks.values():
        default_fuel[mask] = "urban"
    elevation = np.full((grid.rows, grid.cols), np.nan)
    fuel = default_fuel.copy()
    covered = np.zeros((grid.rows, grid.cols), dtype=np.bool_)

    if terrain is not None:
        tx0, ty0 = grid.frame.point(terrain.south_west)
        gx, gy = grid.centers()
        tc = np.floor((gx - tx0) / terrain.cell_size_m).astype(np.int64)
        tr = np.floor((gy - ty0) / terrain.cell_size_m).astype(np.int64)
        covered = (tr >= 0) & (tr < terrain.rows) & (tc >= 0) & (tc < terrain.cols)
        idx = np.where(covered, tr * terrain.cols + tc, 0)
        if terrain.elevation_m is not None:
            layer = np.array(
                [np.nan if v is None else v for v in terrain.elevation_m], dtype=np.float64
            )
            elevation = np.where(covered, layer[idx], np.nan)
        if terrain.fuel is not None:
            fuel = np.where(covered, np.array(terrain.fuel, dtype=object)[idx], default_fuel)

    if terrain is None or terrain.fuel is None or not covered.all():
        assumptions.append(
            "fuel: timber inside the watch zone, shrub outside, urban in civilian areas"
            + (" where the terrain grid does not reach" if terrain and terrain.fuel else "")
        )
    if np.isnan(elevation).all():
        assumptions.append("elevation: flat ground")
        elevation = np.zeros_like(elevation)
    elif np.isnan(elevation).any():
        assumptions.append("elevation: mean height where the terrain grid has no value")
        elevation = np.where(np.isnan(elevation), float(np.nanmean(elevation)), elevation)
    return elevation, fuel


def _weather(ctx: PlannerContext, assumptions: list[str]) -> tuple[Wind, float]:
    w = ctx.weather
    if w is None:
        assumptions.append(
            f"weather: calm, {DEFAULT_TEMPERATURE_C:g} °C, {DEFAULT_HUMIDITY_PCT:g} % humidity"
        )
        return Wind(0.0, (0.0, 0.0)), _dryness(DEFAULT_TEMPERATURE_C, DEFAULT_HUMIDITY_PCT)
    toward = math.radians(w.wind_from_deg + 180.0)
    temp = DEFAULT_TEMPERATURE_C if w.temperature_c is None else w.temperature_c
    rh = DEFAULT_HUMIDITY_PCT if w.relative_humidity_pct is None else w.relative_humidity_pct
    if w.temperature_c is None or w.relative_humidity_pct is None:
        assumptions.append(f"weather: {temp:g} °C and {rh:g} % humidity where not reported")
    return Wind(w.wind_speed_mps, (math.sin(toward), math.cos(toward))), _dryness(temp, rh)


def _dryness(temperature_c: float, humidity_pct: float) -> float:
    rh = 1.0 + (DEFAULT_HUMIDITY_PCT - humidity_pct) / 40.0
    heat = 1.0 + (temperature_c - DEFAULT_TEMPERATURE_C) / 60.0
    return float(np.clip(rh * heat, 0.4, 2.0))


def _detection_mask(grid: Grid, ground: list[LatLng], center: LatLng) -> BoolArray:
    if len(ground) >= 3:
        return grid.polygon_mask(ground)
    mask = np.zeros((grid.rows, grid.cols), dtype=np.bool_)
    r, c, inside = grid.cell_of(*grid.frame.point(center))
    if bool(inside):
        mask[int(r), int(c)] = True
    return mask


def _ignitions(
    ctx: PlannerContext, grid: Grid, now: datetime, at_risk: BoolArray, assumptions: list[str]
) -> dict[int, float]:
    ages = np.full((grid.rows, grid.cols), -1.0)

    def ignite(mask: BoolArray, observed: datetime) -> None:
        age = float(np.clip((now - observed).total_seconds() / 60.0, 0.0, MAX_IGNITION_AGE_MIN))
        ages[mask] = np.maximum(ages[mask], age)

    for z in ctx.risk_zones:
        if z.risk == "on_fire":
            ignite(grid.polygon_mask(z.polygon), z.observed_at)
    for d in ctx.detections:
        if d.risk == "on_fire" and d.confidence >= MIN_DETECTION_CONFIDENCE:
            ignite(_detection_mask(grid, d.ground, d.center), d.captured_at)

    if (ages < 0).all():
        if at_risk.any():
            assumptions.append("ignition: no fire observed, so at-risk areas are ignited now")
            ages[at_risk] = 0.0
        else:
            assumptions.append("ignition: no fire or at-risk area observed; nothing spreads")
    flat = ages.ravel()
    return {int(i): float(flat[i]) for i in np.flatnonzero(flat >= 0)}
