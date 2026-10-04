"""The Celery app both sides share: the orchestrator sends by task name, workers run it."""

from __future__ import annotations

from typing import Any

from celery import Celery

from .settings import Settings
from .wire import PLANNER_CELERY_QUEUE, PLANNER_CELERY_TASK


def make_celery(settings: Settings) -> Any:
    app = Celery("ember_planner", broker=settings.redis_url, backend=settings.redis_url)
    app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        task_default_queue=PLANNER_CELERY_QUEUE,
        task_routes={PLANNER_CELERY_TASK: {"queue": PLANNER_CELERY_QUEUE}},
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        task_time_limit=settings.job_timeout_s,
        worker_prefetch_multiplier=1,
        result_expires=3600,
        broker_connection_retry_on_startup=True,
    )
    return app
