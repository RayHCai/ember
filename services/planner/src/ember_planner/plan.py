"""One planner run: context in, fire spread, attack zones, civilian impacts and routes out."""

from __future__ import annotations

from datetime import UTC, datetime

from .civilians import civilian_impacts, evacuation_routes
from .forecast import forecast
from .landscape import build_landscape
from .network import road_network, terrain_network
from .response import attack_zones
from .spread import simulate
from .wire import Json, PlannerContext, PlannerJobRequest, PlannerResult


def plan(job: PlannerJobRequest, ctx: PlannerContext, now: datetime | None = None) -> PlannerResult:
    if ctx.zone_id != job.zone_id:
        raise ValueError(f"job {job.job_id}: context is for zone {ctx.zone_id}, not {job.zone_id}")
    now = now or datetime.now(UTC)
    opts = job.options
    land = build_landscape(ctx, now)
    spread = simulate(land, opts.horizon_min)
    roads = road_network(ctx.roads, land.grid.frame, land.grid.cell)
    if roads is None:
        land.assumptions.append("roads: none known, so evacuation routes go cross-country")
    impacts = civilian_impacts(ctx.civilian_areas, land, spread)
    needs_routes = any(i.severity != "clear" for i in impacts)
    routes = []
    if needs_routes:
        net = roads or terrain_network(land.grid)
        if not ctx.safe_zones:
            land.assumptions.append(
                "safe zones: none known, so routes lead out of the planning area"
            )
        routes = evacuation_routes(
            ctx.civilian_areas,
            impacts,
            land,
            spread,
            net,
            ctx.safe_zones,
            opts.evacuation_delay_min,
            opts.safety_margin_min,
        )
    if not ctx.stations:
        land.assumptions.append("stations: none known, so attack zones ignore travel time")
    return PlannerResult(
        job_id=job.job_id,
        zone_id=job.zone_id,
        generated_at=now,
        context_generated_at=ctx.generated_at,
        horizon_min=opts.horizon_min,
        assumptions=land.assumptions,
        fire_spread=forecast(spread, land.grid, opts.band_min),
        attack_zones=attack_zones(land, spread, roads, ctx.stations, opts.attack_zone_count),
        civilian_impacts=impacts,
        evacuation_routes=routes,
    )


def run_plan(job: object, context: object) -> Json:
    """The worker's whole job, on wire JSON in and out."""
    return plan(
        PlannerJobRequest.model_validate(job), PlannerContext.model_validate(context)
    ).to_json()
