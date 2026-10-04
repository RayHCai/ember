"""Environment configuration for both planner processes."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    redis_url: str
    api_url: str
    api_key: str
    max_in_flight: int
    job_timeout_s: float
    orchestrator_port: int
    worker_port: int

    @staticmethod
    def from_env() -> Settings:
        env = os.environ
        return Settings(
            redis_url=env.get("EMBER_REDIS_URL", "redis://localhost:6379/0"),
            api_url=env.get("EMBER_API_URL", "http://localhost:4001"),
            api_key=env.get("EMBER_PLANNER_KEY", ""),
            max_in_flight=int(env.get("EMBER_PLANNER_MAX_IN_FLIGHT", "4")),
            job_timeout_s=float(env.get("EMBER_PLANNER_JOB_TIMEOUT_S", "600")),
            orchestrator_port=int(env.get("EMBER_PLANNER_ORCHESTRATOR_PORT", "4007")),
            worker_port=int(env.get("EMBER_PLANNER_WORKER_PORT", "4008")),
        )
