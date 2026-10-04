import json
from typing import Any

import pytest
from conftest import FRAME, NOW, Scenario, job, ll, square
from ember_planner.plan import plan, run_plan
from ember_planner.wire import PlannerContext, PlannerJobRequest, PlannerResult


def make(scenario: Scenario, options: dict[str, Any] | None = None, **ctx: Any) -> PlannerResult:
    return plan(
        PlannerJobRequest.model_validate(job(**(options or {}))),
        PlannerContext.model_validate(scenario(**ctx)),
        NOW,
    )


def xy(p: Any) -> tuple[float, float]:
    return FRAME.point(p)


def test_fire_moves_downwind_and_grows(scenario: Scenario) -> None:
    spread = make(scenario).fire_spread
    assert spread.heading_deg is not None
    assert abs(spread.heading_deg - 90) < 10
    areas = [i.area_ha for i in spread.isochrones]
    assert areas == sorted(areas)
    assert all(i.polygons for i in spread.isochrones)
    assert xy(spread.track[-1].center)[0] > xy(spread.track[0].center)[0] + 1000
    assert len(spread.arrival_min) == spread.grid.cols * spread.grid.rows


def test_downwind_town_is_impacted_upwind_hamlet_is_not(scenario: Scenario) -> None:
    impacts = {i.civilian_area_id: i for i in make(scenario).civilian_impacts}
    town, hamlet = impacts["town"], impacts["hamlet"]
    assert town.impact_min is not None and 0 < town.impact_min < 180
    assert 0 < town.gradient < 1
    assert town.severity in ("immediate", "warning", "watch")
    assert hamlet.impact_min is None and hamlet.gradient == 0 and hamlet.severity == "clear"


def test_burning_area_has_full_gradient(scenario: Scenario) -> None:
    fire = {
        "id": "f",
        "risk": "on_fire",
        "polygon": square(2000, 0, 100),
        "confidence": 1.0,
        "observedAt": NOW.isoformat(),
    }
    town = make(scenario, riskZones=[fire]).civilian_impacts[0]
    assert town.civilian_area_id == "town"
    assert town.gradient == 1 and town.severity == "immediate"


def test_attack_zones_sit_between_fire_and_town_and_are_reachable(scenario: Scenario) -> None:
    result = make(scenario)
    zones = result.attack_zones
    assert 1 <= len(zones) <= 5
    assert [z.rank for z in zones] == list(range(1, len(zones) + 1))
    assert zones[0].score == 1 and all(0 < z.score <= 1 for z in zones)
    assert "town" in zones[0].protects and zones[0].protected_population > 0
    x, _ = xy(zones[0].center)
    assert 0 < x < 2000
    for z in zones:
        assert z.access_min is not None and z.fire_arrival_min >= z.access_min
    for a in zones:
        for b in zones:
            if a.id < b.id:
                (ax, ay), (bx, by) = xy(a.center), xy(b.center)
                assert ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 >= 400
    # Drop sites are on the highway (y = -600) or Main St (x = 2000).
    for z in zones:
        dx, dy = xy(z.drop_site)
        assert abs(dy + 600) < 2 or abs(dx - 2000) < 2


def test_attack_zone_count_is_honoured(scenario: Scenario) -> None:
    assert make(scenario, {"attackZoneCount": 1}).attack_zones[0].rank == 1
    assert len(make(scenario, {"attackZoneCount": 1}).attack_zones) == 1
    assert make(scenario, {"attackZoneCount": 0}).attack_zones == []


def test_town_evacuates_north_away_from_the_fire(scenario: Scenario) -> None:
    (route,) = make(scenario).evacuation_routes
    assert route.civilian_area_id == "town"
    assert route.status == "clear" and route.network == "roads"
    assert route.destination is not None and route.destination.safe_zone_id == "north"
    assert route.clearance_min is not None and route.clearance_min >= 30
    assert xy(route.path[-1])[1] > 2700


def test_route_never_runs_into_the_fire(scenario: Scenario) -> None:
    fire_on_main_st = {
        "id": "f2",
        "risk": "on_fire",
        "polygon": square(2000, 1200, 250),
        "confidence": 1.0,
        "observedAt": NOW.isoformat(),
    }
    zones = [
        {"id": "f1", **_fire_at_origin()},
        fire_on_main_st,
    ]
    (blocked,) = make(scenario, riskZones=zones).evacuation_routes
    assert blocked.status == "no_safe_route" and blocked.path == []

    east = {"id": "east", "name": "East exit", "location": ll(4000, -600), "capacity": None}
    north = scenario()["safeZones"][0]
    (route,) = make(scenario, riskZones=zones, safeZones=[north, east]).evacuation_routes
    assert route.destination is not None and route.destination.safe_zone_id == "east"
    assert route.clearance_min is None or route.clearance_min >= 15


def test_without_safe_zones_routes_leave_the_planning_area(scenario: Scenario) -> None:
    result = make(scenario, safeZones=[])
    (route,) = result.evacuation_routes
    assert route.status != "no_safe_route"
    assert route.destination is not None and route.destination.safe_zone_id is None
    assert any("safe zones" in a for a in result.assumptions)


def test_without_roads_routes_go_cross_country(scenario: Scenario) -> None:
    result = make(scenario, roads=[], stations=[])
    (route,) = result.evacuation_routes
    assert route.network == "terrain" and route.status != "no_safe_route"
    assert all(z.access_min is None for z in result.attack_zones)
    assert {"roads", "stations"} <= {a.split(":")[0] for a in result.assumptions}


def test_no_fire_gives_an_empty_plan(scenario: Scenario) -> None:
    result = make(scenario, riskZones=[])
    assert result.fire_spread.isochrones == []
    assert result.attack_zones == [] and result.evacuation_routes == []
    assert all(i.severity == "clear" for i in result.civilian_impacts)


def test_context_for_another_zone_is_refused(scenario: Scenario) -> None:
    with pytest.raises(ValueError, match="zone-2"):
        make(scenario, zoneId="zone-2")


def test_run_plan_speaks_camel_case_json(scenario: Scenario) -> None:
    out = run_plan(job(), scenario())
    text = json.dumps(out)
    assert out["jobId"] == "job-1" and out["generatedAt"]
    assert "fireSpread" in out and "arrival_min" not in text
    assert PlannerResult.model_validate(json.loads(text)).job_id == "job-1"


def _fire_at_origin() -> dict[str, Any]:
    return {
        "risk": "on_fire",
        "polygon": square(0, 0, 60),
        "confidence": 0.9,
        "observedAt": NOW.isoformat(),
    }
