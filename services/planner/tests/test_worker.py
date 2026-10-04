from conftest import Scenario, job
from ember_planner.wire import PLANNER_CELERY_TASK, PlannerResult
from ember_planner.worker import app, plan_task


def test_plan_task_is_registered_under_the_contract_name() -> None:
    assert plan_task.name == PLANNER_CELERY_TASK and PLANNER_CELERY_TASK in app.tasks


def test_plan_task_runs_on_wire_json(scenario: Scenario) -> None:
    out = plan_task.apply(args=[job(), scenario()]).get()
    assert PlannerResult.model_validate(out).zone_id == "zone-1"
