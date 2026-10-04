"""`ember-planner orchestrator | worker | plan`."""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

from .wire import PLANNER_CELERY_QUEUE


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="ember-planner")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("orchestrator", help="watch the Redis job queue and dispatch to workers")
    worker = sub.add_parser("worker", help="run a Celery planner worker")
    worker.add_argument("--concurrency", type=int, default=None)
    worker.add_argument(
        "--pool",
        default="solo" if sys.platform in ("win32", "darwin") else "prefork",
        help="Celery pool",
    )
    offline = sub.add_parser("plan", help="plan one context file offline and print the result")
    offline.add_argument("context", type=Path, help="PlannerContext JSON")
    offline.add_argument("--job", type=Path, help="PlannerJobRequest JSON (default: a local job)")
    offline.add_argument("--out", type=Path, help="write the PlannerResult here instead of stdout")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.command == "orchestrator":
        _orchestrator()
    elif args.command == "worker":
        _worker(args.concurrency, args.pool)
    else:
        _plan(args.context, args.job, args.out)


def _orchestrator() -> None:
    import redis

    from .celery_app import make_celery
    from .health import serve_health
    from .orchestrator import CeleryDispatcher, HttpPlannerApi, Orchestrator, RedisJobQueue
    from .settings import Settings

    settings = Settings.from_env()
    if not settings.api_key:
        sys.exit("EMBER_PLANNER_KEY is unset: every api call is authenticated with it")
    redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    api = HttpPlannerApi.connect(settings.api_url, settings.api_key)
    orch = Orchestrator(
        RedisJobQueue(redis_client),
        api,
        CeleryDispatcher(make_celery(settings)),
        max_in_flight=settings.max_in_flight,
        job_timeout_s=settings.job_timeout_s,
    )
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    health = serve_health(
        "planner-orchestrator",
        settings.orchestrator_port,
        lambda: {"inFlight": len(orch.in_flight)},
    )
    try:
        orch.run(stop)
    finally:
        health.shutdown()
        api.close()
        redis_client.close()


def _worker(concurrency: int | None, pool: str) -> None:
    from .worker import app

    argv = ["worker", "-Q", PLANNER_CELERY_QUEUE, "--loglevel=INFO", f"--pool={pool}"]
    if concurrency:
        argv.append(f"--concurrency={concurrency}")
    app.worker_main(argv)


def _plan(context: Path, job_path: Path | None, out: Path | None) -> None:
    from .plan import run_plan

    ctx = json.loads(context.read_text(encoding="utf-8"))
    job = (
        json.loads(job_path.read_text(encoding="utf-8"))
        if job_path
        else {
            "jobId": "local",
            "zoneId": ctx.get("zoneId"),
            "requestedAt": datetime.now(UTC).isoformat(),
            "requestedBy": "cli",
        }
    )
    text = json.dumps(run_plan(job, ctx), indent=2)
    if out:
        out.write_text(text, encoding="utf-8")
    else:
        print(text)
