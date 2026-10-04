from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    seed: str
    port: int
    health_port: int
    operator_agent_url: str
    chat_key: str | None
    timeout_s: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        e = os.environ if env is None else env
        seed = e.get("EMBER_UAGENT_SEED", "").strip()
        if not seed:
            raise SystemExit("EMBER_UAGENT_SEED is required: set it in .env (the agent's identity)")
        return cls(
            seed=seed,
            port=int(e.get("EMBER_UAGENT_PORT") or 8001),
            health_port=int(e.get("EMBER_UAGENT_HEALTH_PORT") or 4009),
            operator_agent_url=(
                e.get("EMBER_OPERATOR_AGENT_URL") or "http://localhost:4006"
            ).rstrip("/"),
            chat_key=e.get("EMBER_AGENT_CHAT_KEY") or None,
            timeout_s=float(e.get("EMBER_UAGENT_TIMEOUT_S") or 90),
        )
