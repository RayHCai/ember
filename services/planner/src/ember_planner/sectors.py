"""Grades square sectors of the watch zone on how readily fire would start and run there now and
who it would reach, so an operator sees where attention is needed before a fire exists.

Sectors are numbered row by row from the north-west corner. The score blends three factors, each
0 to 1: spread potential (the fastest the landscape could burn under today's weather), ignition
(nearness to observed fire) and exposure (people close by).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import shapely

from .grid import BoolArray, FloatArray, Grid
from .landscape import Landscape
from .spread import Spread, slope_factor, wind_head_factor
from .wire import (
    CivilianArea,
    FuelType,
    LatLng,
    PlannerContext,
    RiskBand,
    SectorFactors,
    SectorRisk,
    Weather,
)

# A head fire this fast across burnable ground is the top of the spread-potential scale.
REFERENCE_RATE_MPM = 20.0
IGNITION_FLOOR = 0.1
IGNITION_DECAY_M = 1500.0
AT_RISK_WEIGHT = 0.6
EXPOSURE_RADIUS_M = 1500.0
EXPOSURE_REFERENCE_PEOPLE = 2000.0
WEIGHTS = (0.5, 0.3, 0.2)
BAND_LIMITS: tuple[tuple[float, RiskBand], ...] = ((0.3, "low"), (0.5, "moderate"), (0.7, "high"))
MAX_SECTORS = 400
# Clipped pieces smaller than this share of a full sector are edge slivers, not sectors.
MIN_SECTOR_SHARE = 1e-3
MAX_DRIVERS = 4
FIRE_NEAR_M = 3000.0
DRIVER_MIN_WIND_MPS = 3.0
DRIVER_WIND_FULL_MPS = 15.0
DRIVER_MAX_HUMIDITY_PCT = 35.0
DRIVER_MIN_SLOPE_DEG = 5.0
DRIVER_SLOPE_FULL_DEG = 30.0
RED_FLAG_STRENGTH = 0.9


@dataclass(frozen=True)
class _Source:
    geometry: shapely.geometry.base.BaseGeometry
    weight: float
    burning: bool


def sector_risks(
    ctx: PlannerContext, land: Landscape, spread: Spread, size_m: float
) -> list[SectorRisk]:
    g = land.grid
    boundary = shapely.Polygon(g.frame.ring(ctx.boundary)).buffer(0)
    pieces = _sectors(boundary, size_m)
    potential = _potential_rate(land) / REFERENCE_RATE_MPM
    slope_deg = _slope_deg(land)
    sources = _sources(ctx, g)
    people = [(g.frame.point(a.center), a) for a in ctx.civilian_areas]

    drafts = []
    for number, piece in enumerate(pieces, start=1):
        centre = piece.centroid
        cells = _cells(g, piece)
        burnable = land.base_ros[cells] > 0
        spread_potential = (
            float(np.clip(potential[cells][burnable].mean(), 0.0, 1.0)) if burnable.any() else 0.0
        )
        ignition, fire_d = _ignition(piece, centre, sources)
        population = _population(centre, people)
        exposure = float(np.clip(population / EXPOSURE_REFERENCE_PEOPLE, 0.0, 1.0))
        score = round(
            WEIGHTS[0] * spread_potential + WEIGHTS[1] * ignition + WEIGHTS[2] * exposure, 3
        )
        fuel = _dominant_fuel(land.fuel[cells])
        slope = float(slope_deg[cells].mean())
        arrival = spread.arrival[cells]
        finite = arrival[np.isfinite(arrival)]
        drafts.append(
            (
                number,
                score,
                SectorRisk(
                    id=f"S{number}",
                    number=number,
                    polygon=_ring(g, piece),
                    center=g.frame.to_latlng(centre.x, centre.y),
                    rank=0,
                    score=score,
                    band=_band(score),
                    factors=SectorFactors(
                        spread_potential=round(spread_potential, 3),
                        ignition=round(ignition, 3),
                        exposure=round(exposure, 3),
                    ),
                    dominant_fuel=fuel,
                    mean_slope_deg=round(slope, 1),
                    population=round(population, 1),
                    fire_arrival_min=round(float(finite.min()), 1) if finite.size else None,
                    drivers=_drivers(
                        ctx.weather, fuel, slope, fire_d, ignition, population, exposure
                    ),
                ),
            )
        )
    drafts.sort(key=lambda d: (-d[1], d[0]))
    return [d[2].model_copy(update={"rank": k}) for k, d in enumerate(drafts, start=1)]


def _sectors(boundary: shapely.geometry.base.BaseGeometry, size: float) -> list[shapely.Polygon]:
    minx, miny, maxx, maxy = boundary.bounds
    w, h = maxx - minx, maxy - miny
    size = max(size, math.sqrt(w * h / MAX_SECTORS))
    out: list[shapely.Polygon] = []
    for r in range(max(1, math.ceil(h / size))):
        top = maxy - r * size
        for c in range(max(1, math.ceil(w / size))):
            left = minx + c * size
            clipped = boundary.intersection(shapely.box(left, top - size, left + size, top))
            parts = (
                [clipped] if clipped.geom_type == "Polygon" else list(shapely.get_parts(clipped))
            )
            polys = [p for p in parts if p.geom_type == "Polygon" and not p.is_empty]
            if not polys:
                continue
            biggest = max(polys, key=lambda p: p.area)
            if biggest.area >= MIN_SECTOR_SHARE * size * size:
                out.append(biggest)
    return out


def _ring(g: Grid, piece: shapely.Polygon) -> list[LatLng]:
    return [g.frame.to_latlng(float(x), float(y)) for x, y in list(piece.exterior.coords)[:-1]]


def _cells(g: Grid, piece: shapely.Polygon) -> BoolArray:
    """Planning cells whose centre is inside the sector; its centroid's cell when none is."""
    minx, miny, maxx, maxy = piece.bounds
    r0, c0, _ = g.cell_of(minx, miny)
    r1, c1, _ = g.cell_of(maxx, maxy)
    gx, gy = g.centers()
    mask = np.zeros((g.rows, g.cols), dtype=np.bool_)
    window = (slice(int(r0), int(r1) + 1), slice(int(c0), int(c1) + 1))
    mask[window] = shapely.contains_xy(piece, gx[window], gy[window])
    if not mask.any():
        r, c, _ = g.cell_of(piece.centroid.x, piece.centroid.y)
        mask[int(r), int(c)] = True
    return mask


def _potential_rate(land: Landscape) -> FloatArray:
    """Fastest the fire could enter each cell: head fire running upslope."""
    g = land.grid
    d_row, d_col = np.gradient(land.elevation, g.cell)
    slope = slope_factor(np.hypot(d_row, d_col))
    head = wind_head_factor(land.wind.speed_mps)
    return np.asarray(land.base_ros * land.dryness * head * slope, dtype=np.float64)


def _slope_deg(land: Landscape) -> FloatArray:
    d_row, d_col = np.gradient(land.elevation, land.grid.cell)
    return np.asarray(np.degrees(np.arctan(np.hypot(d_row, d_col))), dtype=np.float64)


def _sources(ctx: PlannerContext, g: Grid) -> list[_Source]:
    out = [
        _Source(
            shapely.Polygon(g.frame.ring(z.polygon)).buffer(0),
            z.confidence * _risk_weight(z.risk),
            z.risk == "on_fire",
        )
        for z in ctx.risk_zones
    ]
    for d in ctx.detections:
        geometry = (
            shapely.Polygon(g.frame.ring(d.ground)).buffer(0)
            if len(d.ground) >= 3
            else shapely.Point(g.frame.point(d.center))
        )
        out.append(_Source(geometry, d.confidence * _detection_scale(d.risk), d.risk == "on_fire"))
    return out


def _risk_weight(risk: str) -> float:
    return 1.0 if risk == "on_fire" else AT_RISK_WEIGHT


def _detection_scale(risk: str) -> float:
    return 1.0 if risk == "on_fire" else AT_RISK_WEIGHT


def _ignition(
    piece: shapely.Polygon, centre: shapely.Point, sources: list[_Source]
) -> tuple[float, float | None]:
    """Ignition factor, and the distance to the nearest burning source."""
    best = IGNITION_FLOOR
    nearest: float | None = None
    for s in sources:
        d = 0.0 if piece.intersects(s.geometry) else float(centre.distance(s.geometry))
        best = max(best, s.weight * math.exp(-d / IGNITION_DECAY_M))
        if s.burning and (nearest is None or d < nearest):
            nearest = d
    return best, nearest


def _population(
    centre: shapely.Point, people: list[tuple[tuple[float, float], CivilianArea]]
) -> float:
    return float(
        sum(
            a.population
            for (x, y), a in people
            if math.hypot(x - centre.x, y - centre.y) <= EXPOSURE_RADIUS_M
        )
    )


def _dominant_fuel(fuel: np.ndarray) -> FuelType:
    names, counts = np.unique(fuel.astype(str), return_counts=True)
    top: FuelType = str(names[int(np.argmax(counts))])  # type: ignore[assignment]
    return top


def _band(score: float) -> RiskBand:
    for limit, band in BAND_LIMITS:
        if score < limit:
            return band
    return "extreme"


def _drivers(
    weather: Weather | None,
    fuel: FuelType,
    slope_deg: float,
    fire_distance: float | None,
    ignition: float,
    population: float,
    exposure: float,
) -> list[str]:
    found: list[tuple[float, str]] = []
    if weather is not None:
        if weather.wind_speed_mps >= DRIVER_MIN_WIND_MPS:
            strength = min(weather.wind_speed_mps / DRIVER_WIND_FULL_MPS, 1.0)
            found.append(
                (
                    strength,
                    f"wind {weather.wind_speed_mps:.1f} m/s from {weather.wind_from_deg:.0f}°",
                )
            )
        if weather.red_flag_warning:
            found.append((RED_FLAG_STRENGTH, "red flag warning"))
        rh = weather.relative_humidity_pct
        if rh is not None and rh <= DRIVER_MAX_HUMIDITY_PCT:
            found.append(
                ((DRIVER_MAX_HUMIDITY_PCT - rh) / DRIVER_MAX_HUMIDITY_PCT, f"humidity {rh:.0f}%")
            )
    if fuel != "none":
        found.append((0.5, f"fuel {fuel}"))
    if slope_deg >= DRIVER_MIN_SLOPE_DEG:
        found.append((min(slope_deg / DRIVER_SLOPE_FULL_DEG, 1.0), f"slope {slope_deg:.0f}°"))
    if fire_distance is not None and fire_distance <= FIRE_NEAR_M:
        where = (
            "fire detected in sector"
            if fire_distance == 0
            else f"fire detected {max(100, round(fire_distance, -2)):.0f} m away"
        )
        found.append((ignition, where))
    if population >= 1:
        found.append((exposure, f"{population:,.0f} people within 1.5 km"))
    found.sort(key=lambda f: -f[0])
    return [text for _, text in found[:MAX_DRIVERS]]
