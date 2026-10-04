import pytest
from conftest import Scenario, job, ll
from ember_planner.wire import PlannerContext, PlannerJobRequest
from pydantic import ValidationError


def test_context_round_trips_camel_case(scenario: Scenario) -> None:
    ctx = PlannerContext.model_validate(scenario())
    out = ctx.to_json()
    assert out["zoneId"] == "zone-1" and "civilianAreas" in out
    assert PlannerContext.model_validate(out) == ctx


def test_job_options_default() -> None:
    raw = job()
    del raw["options"]
    opts = PlannerJobRequest.model_validate(raw).options
    assert (opts.horizon_min, opts.band_min, opts.attack_zone_count) == (180, 30, 5)
    assert (opts.evacuation_delay_min, opts.safety_margin_min) == (10, 15)


def test_terrain_layers_must_fit_the_grid(scenario: Scenario) -> None:
    terrain = {
        "southWest": ll(0, 0),
        "cellSizeM": 30,
        "cols": 2,
        "rows": 2,
        "elevationM": [1, 2, 3],
        "fuel": None,
    }
    with pytest.raises(ValidationError, match="3 values for 4 cells"):
        PlannerContext.model_validate(scenario(terrain=terrain))


def test_boundary_needs_three_points(scenario: Scenario) -> None:
    with pytest.raises(ValidationError):
        PlannerContext.model_validate(scenario(boundary=[ll(0, 0), ll(1, 1)]))
