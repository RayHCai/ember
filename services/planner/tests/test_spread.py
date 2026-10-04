from collections.abc import Callable
from datetime import timedelta
from typing import Any

import numpy as np
import pytest
from conftest import NOW, Scenario, iso, ll, square
from ember_planner.landscape import build_landscape
from ember_planner.spread import Spread, simulate
from ember_planner.wire import PlannerContext

CELL = 30.0
HALF = 1800.0


def terrain(
    fuel: Callable[[float, float], str] = lambda x, y: "grass",
    elevation: Callable[[float, float], float] = lambda x, y: 0.0,
) -> dict[str, Any]:
    n = int(2 * HALF / CELL)
    fuels, heights = [], []
    for r in range(n):
        for c in range(n):
            x, y = -HALF + (c + 0.5) * CELL, -HALF + (r + 0.5) * CELL
            fuels.append(fuel(x, y))
            heights.append(elevation(x, y))
    return {
        "southWest": ll(-HALF, -HALF),
        "cellSizeM": CELL,
        "cols": n,
        "rows": n,
        "elevationM": heights,
        "fuel": fuels,
    }


def weather(speed: float = 0.0, from_deg: float = 270.0) -> dict[str, Any]:
    return {
        "observedAt": iso(NOW),
        "windSpeedMps": speed,
        "windFromDeg": from_deg,
        "temperatureC": 25.0,
        "relativeHumidityPct": 30.0,
    }


def run(scenario: Scenario, horizon: float = 180.0, **overrides: Any) -> tuple[Spread, Any]:
    ctx = scenario(
        boundary=square(0, 0, 300),
        civilianAreas=[],
        safeZones=[],
        stations=[],
        roads=[],
        **{"terrain": terrain(), "weather": weather(), **overrides},
    )
    land = build_landscape(PlannerContext.model_validate(ctx), NOW)
    return simulate(land, horizon), land


def at(spread: Spread, land: Any, x: float, y: float) -> float:
    r, c, inside = land.grid.cell_of(x, y)
    assert inside
    return float(spread.arrival[int(r), int(c)])


def test_calm_flat_fire_spreads_evenly(scenario: Scenario) -> None:
    spread, land = run(scenario)
    times = [at(spread, land, x, y) for x, y in [(400, 0), (-400, 0), (0, 400), (0, -400)]]
    diagonal = at(spread, land, 283, 283)
    assert max(times) < 180
    assert max(times) - min(times) < 0.1 * np.mean(times)
    assert abs(diagonal - np.mean(times)) < 0.12 * np.mean(times)


def test_wind_drives_fire_downwind(scenario: Scenario) -> None:
    spread, land = run(scenario, weather=weather(8.0, from_deg=270.0))
    downwind = at(spread, land, 600, 0)
    upwind = at(spread, land, -600, 0)
    assert downwind < 60
    assert upwind > 4 * downwind


def test_fire_runs_faster_uphill(scenario: Scenario) -> None:
    spread, land = run(scenario, terrain=terrain(elevation=lambda x, y: 0.3 * y))
    assert at(spread, land, 0, 300) < 0.5 * at(spread, land, 0, -300)


def test_fuel_break_stops_the_fire(scenario: Scenario) -> None:
    spread, land = run(
        scenario,
        terrain=terrain(fuel=lambda x, y: "none" if 200 <= x <= 290 else "grass"),
        weather=weather(10.0, from_deg=270.0),
    )
    assert at(spread, land, 150, 0) < 60
    assert not np.isfinite(at(spread, land, 400, 0))


def test_older_fire_has_spread_further(scenario: Scenario) -> None:
    def zone(age_min: float) -> list[dict[str, Any]]:
        observed = NOW - timedelta(minutes=age_min)
        return [
            {
                "id": "f",
                "risk": "on_fire",
                "polygon": square(0, 0, 30),
                "confidence": 1.0,
                "observedAt": iso(observed),
            }
        ]

    fresh, _ = run(scenario, riskZones=zone(0))
    old, _ = run(scenario, riskZones=zone(40))
    assert (old.arrival <= 0).sum() > (fresh.arrival <= 0).sum()


def test_without_fire_nothing_spreads(scenario: Scenario) -> None:
    spread, land = run(scenario, riskZones=[])
    assert not spread.reached.any()
    assert any("nothing spreads" in a for a in land.assumptions)


def test_at_risk_area_is_ignited_when_no_fire_is_seen(scenario: Scenario) -> None:
    zone = {
        "id": "dry",
        "risk": "at_risk",
        "polygon": square(0, 0, 60),
        "confidence": 0.8,
        "observedAt": iso(NOW),
    }
    spread, land = run(scenario, riskZones=[zone])
    assert spread.reached.any()
    assert any("at-risk areas are ignited" in a for a in land.assumptions)


@pytest.mark.parametrize("confidence, ignites", [(0.9, True), (0.1, False)])
def test_confident_detections_ignite(scenario: Scenario, confidence: float, ignites: bool) -> None:
    detection = {
        "id": "d1",
        "risk": "on_fire",
        "confidence": confidence,
        "bboxPx": [10, 10, 40, 40],
        "ground": square(0, 0, 20),
        "center": ll(0, 0),
        "droneId": "drone-1",
        "capturedAt": iso(NOW),
    }
    spread, _ = run(scenario, riskZones=[], detections=[detection])
    assert spread.reached.any() == ignites
