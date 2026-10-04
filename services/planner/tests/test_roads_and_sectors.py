from typing import Any

from conftest import FRAME, NOW, Scenario, build_context, job, ll
from ember_planner.plan import plan
from ember_planner.wire import PlannerContext, PlannerJobRequest, PlannerResult

SIDE_ROAD = {
    "id": "side",
    "name": "Side Rd",
    "kind": "secondary",
    "path": [ll(2000, 0), ll(2600, 0), ll(2600, 2800), ll(2000, 2800)],
}


def make(scenario: Scenario, options: dict[str, Any] | None = None, **ctx: Any) -> PlannerResult:
    return plan(
        PlannerJobRequest.model_validate(job(**(options or {}))),
        PlannerContext.model_validate(scenario(**ctx)),
        NOW,
    )


def roads_with(*extra: dict[str, Any], **state: str) -> list[dict[str, Any]]:
    return [{**r, "state": state.get(r["id"], "open")} for r in [*build_context()["roads"], *extra]]


def weather(**changes: Any) -> dict[str, Any]:
    return {**build_context()["weather"], **changes}


def test_blocked_road_is_avoided_and_named(scenario: Scenario) -> None:
    open_result = make(scenario, roads=roads_with(SIDE_ROAD))
    assert open_result.evacuation_routes[0].road_ids == ["side"]
    result = make(scenario, roads=roads_with(SIDE_ROAD, side="blocked"))
    (route,) = result.evacuation_routes
    assert route.road_ids == ["main"]
    assert "roads: Side Rd (side) blocked, so no route uses it" in result.assumptions


def test_blocked_main_street_changes_the_route(scenario: Scenario) -> None:
    assert make(scenario).evacuation_routes[0].road_ids == ["main"]
    (route,) = make(scenario, roads=roads_with(main="blocked")).evacuation_routes
    assert "main" not in route.road_ids


def test_uncertain_road_is_slower(scenario: Scenario) -> None:
    fast = make(scenario).evacuation_routes[0]
    slow = make(scenario, roads=roads_with(main="uncertain")).evacuation_routes[0]
    assert slow.road_ids == fast.road_ids == ["main"]
    assert slow.eta_min > fast.eta_min
    result = make(scenario, roads=roads_with(main="uncertain"))
    assert any("uncertain" in a and "half speed" in a for a in result.assumptions)


def test_alternate_uses_none_of_the_primary_roads(scenario: Scenario) -> None:
    (route,) = make(scenario, roads=roads_with(SIDE_ROAD)).evacuation_routes
    assert route.alternate is not None and route.road_ids
    assert route.alternate.status != "no_safe_route" and route.alternate.road_ids
    assert not set(route.alternate.road_ids) & set(route.road_ids)
    assert len(set(route.road_ids)) == len(route.road_ids)


def test_no_alternate_without_a_second_road_or_roads(scenario: Scenario) -> None:
    assert make(scenario).evacuation_routes[0].alternate is None
    (route,) = make(scenario, roads=[], stations=[]).evacuation_routes
    assert route.alternate is None and route.road_ids == []


def test_attack_zones_have_a_road_approach(scenario: Scenario) -> None:
    zones = make(scenario).attack_zones
    assert zones
    for z in zones:
        a = z.approach
        assert a is not None and a.station_id == "st-1" and a.road_ids
        assert a.eta_min > 0 and len(a.path) >= 2
        assert a.arrives_from_deg is not None and 0 <= a.arrives_from_deg < 360
        assert a.path[-1] == z.drop_site
    # The station is west and Main St runs north-south: crews reach Main St drops from the south.
    on_main = [z for z in zones if "main" in (z.approach.road_ids if z.approach else [])]
    assert on_main and all(
        abs((z.approach.arrives_from_deg or 0) - 180) < 1
        for z in on_main
        if z.approach and z.approach.road_ids[-1] == "main"
    )


def test_approach_respects_blocked_roads_and_needs_stations_and_roads(
    scenario: Scenario,
) -> None:
    assert all(z.approach is None for z in make(scenario, stations=[]).attack_zones)
    assert all(z.approach is None for z in make(scenario, roads=[]).attack_zones)
    result = make(scenario, roads=roads_with(hwy="blocked"))
    approaches = [z.approach for z in result.attack_zones if z.approach]
    assert all("hwy" not in a.road_ids for a in approaches)


def test_sectors_are_numbered_from_the_north_west(scenario: Scenario) -> None:
    risks = make(scenario).sector_risks
    by_number = sorted(risks, key=lambda s: s.number)
    assert [s.id for s in by_number] == [f"S{i}" for i in range(1, 10)]
    centres = [FRAME.point(s.center) for s in by_number]
    assert centres[0][0] < centres[1][0] < centres[2][0]
    assert centres[0][1] > centres[3][1] > centres[6][1]
    assert abs(centres[0][0] + 1000) < 5 and abs(centres[0][1] - 1000) < 5
    assert all(len(s.polygon) == 4 for s in risks)
    assert [s.rank for s in risks] == list(range(1, 10))
    assert [s.score for s in risks] == sorted((s.score for s in risks), reverse=True)


def test_sector_size_changes_the_grid(scenario: Scenario) -> None:
    assert len(make(scenario, {"sectorSizeM": 1500}).sector_risks) == 4
    assert len(make(scenario, {"sectorSizeM": 5000}).sector_risks) == 1


def test_sector_with_fire_and_people_is_graded_high(scenario: Scenario) -> None:
    risks = {s.id: s for s in make(scenario).sector_risks}
    fire = risks["S5"]
    assert fire.rank == 1 and fire.factors.ignition > 0.8 and fire.fire_arrival_min is not None
    assert "fire detected in sector" in fire.drivers
    assert len(fire.drivers) <= 4 and any(
        d.startswith("wind 12.0 m/s from 270") for d in fire.drivers
    )
    east = risks["S6"]
    assert east.population == 500 and east.factors.exposure == 0.25
    calm = make(scenario, weather=weather(windSpeedMps=0.0, relativeHumidityPct=60.0))
    assert any("500 people" in d for d in {s.id: s for s in calm.sector_risks}["S6"].drivers)


def test_bands_follow_the_score(scenario: Scenario) -> None:
    calm = make(
        scenario,
        riskZones=[],
        weather=weather(windSpeedMps=0.0, relativeHumidityPct=60.0, temperatureC=15.0),
        civilianAreas=[],
    )
    assert {s.band for s in calm.sector_risks} == {"low"}
    assert all(s.factors.ignition == 0.1 for s in calm.sector_risks)
    for s in make(scenario).sector_risks:
        expected = (
            "low"
            if s.score < 0.3
            else "moderate"
            if s.score < 0.5
            else "high"
            if s.score < 0.7
            else "extreme"
        )
        assert s.band == expected


def test_score_rises_with_wind_and_falls_with_humidity(scenario: Scenario) -> None:
    def scores(**changes: Any) -> dict[str, float]:
        result = make(scenario, weather=weather(**changes))
        return {s.id: s.score for s in result.sector_risks}

    mild = scores(windSpeedMps=3.0)
    windy = scores(windSpeedMps=14.0)
    assert all(windy[k] > mild[k] for k in mild)
    damp = scores(relativeHumidityPct=45.0)
    dry = scores(relativeHumidityPct=15.0)
    assert all(dry[k] > damp[k] for k in damp)


def test_red_flag_and_humidity_show_as_drivers(scenario: Scenario) -> None:
    result = make(
        scenario, weather=weather(redFlagWarning=True, relativeHumidityPct=28.0, windSpeedMps=0.0)
    )
    drivers = result.sector_risks[0].drivers
    assert "red flag warning" in drivers and "humidity 28%" in drivers


def test_new_fields_round_trip(scenario: Scenario) -> None:
    result = make(scenario, roads=roads_with(SIDE_ROAD, side="uncertain"))
    out = result.to_json()
    assert PlannerResult.model_validate(out) == result
    sector = out["sectorRisks"][0]  # type: ignore[index]
    assert {"spreadPotential", "ignition", "exposure"} == set(sector["factors"])
    assert "roadIds" in out["evacuationRoutes"][0] and "alternate" in out["evacuationRoutes"][0]  # type: ignore[index]
    assert "arrivesFromDeg" in out["attackZones"][0]["approach"]  # type: ignore[index]


def test_older_context_still_validates(scenario: Scenario) -> None:
    raw = scenario()
    ctx = PlannerContext.model_validate(raw)
    assert ctx.weather is not None
    assert (ctx.weather.wind_gust_mps, ctx.weather.red_flag_warning) == (None, None)
    assert ctx.weather.source == "unknown"
    assert all(r.state == "open" for r in ctx.roads)
    assert PlannerJobRequest.model_validate(job()).options.sector_size_m == 1000
