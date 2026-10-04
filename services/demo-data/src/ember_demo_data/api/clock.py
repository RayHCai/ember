"""Scenario clock: maps wall-clock time to a moment in Aug 2023 at a configurable speed."""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta
from typing import Any

from ..config import DEFAULT_CLOCK_START, HST, SCENARIO_END, SCENARIO_START


class ScenarioClock:
    def __init__(
        self, start: datetime = DEFAULT_CLOCK_START, speed: float = 1.0, paused: bool = False
    ):
        self._lock = threading.Lock()
        self._anchor_scenario = start
        self._anchor_wall = time.monotonic()
        self._speed = speed
        self._paused = paused

    def now(self) -> datetime:
        with self._lock:
            if self._paused:
                t = self._anchor_scenario
            else:
                elapsed = (time.monotonic() - self._anchor_wall) * self._speed
                t = self._anchor_scenario + timedelta(seconds=elapsed)
        return min(max(t, SCENARIO_START), SCENARIO_END)

    def set(
        self,
        scenario_time: datetime | None = None,
        speed: float | None = None,
        paused: bool | None = None,
    ) -> None:
        current = self.now()
        with self._lock:
            self._anchor_scenario = scenario_time or current
            self._anchor_wall = time.monotonic()
            if speed is not None:
                if not 0 < speed <= 3600:
                    raise ValueError("speed must be in (0, 3600] scenario seconds per wall second")
                self._speed = speed
            if paused is not None:
                self._paused = paused

    def state(self) -> dict[str, Any]:
        return {
            "scenario_time": self.now().astimezone(HST).isoformat(),
            "speed": self._speed,
            "paused": self._paused,
            "range": [SCENARIO_START.isoformat(), SCENARIO_END.isoformat()],
        }


def from_env() -> ScenarioClock:
    start = os.environ.get("EMBER_CLOCK_START")
    speed = float(os.environ.get("EMBER_CLOCK_SPEED", "1"))
    t = datetime.fromisoformat(start) if start else DEFAULT_CLOCK_START
    if t.tzinfo is None:
        t = t.replace(tzinfo=HST)
    return ScenarioClock(t, speed)
