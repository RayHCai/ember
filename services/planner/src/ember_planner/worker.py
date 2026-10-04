"""Celery worker: `ember-planner worker`, or `celery -A ember_planner.worker worker -Q planner`."""

from __future__ import annotations

from typing import Any

from celery.signals import worker_ready, worker_shutdown

from .celery_app import make_celery
from .health import serve_health
from .plan import run_plan
from .settings import Settings
from .wire import PLANNER_CELERY_TASK

settings = Settings.from_env()
app = make_celery(settings)
plan_task = app.task(name=PLANNER_CELERY_TASK)(run_plan)

_health: list[Any] = []


@worker_ready.connect  # type: ignore[untyped-decorator]
def _serve_health(**_: object) -> None:
    _health.append(serve_health("planner-worker", settings.worker_port))


@worker_shutdown.connect  # type: ignore[untyped-decorator]
def _stop_health(**_: object) -> None:
    while _health:
        _health.pop().shutdown()
