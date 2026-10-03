"""The one simulation clock. Every timed process runs on it.

`speed` is sim seconds per real second. Schedules, battery drain, charging and
fire spread all read `now()` and wait with `sleep()`, so changing the speed
changes the pace of everything at once.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

MAX_SPEED = 3600.0


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class SimClock:
    def __init__(
        self,
        speed: float = 1.0,
        start: datetime | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._monotonic = monotonic
        self._anchor_real = monotonic()
        self._anchor_sim = start or datetime.now(timezone.utc).replace(microsecond=0)
        self._speed = self._validate(speed)
        self._paused = False
        self._waiters: set[asyncio.Event] = set()
        self._listeners: list[Callable[[dict], None]] = []

    @staticmethod
    def _validate(speed: float) -> float:
        if not 0 < speed <= MAX_SPEED:
            raise ValueError(f"speed must be between 0 and {MAX_SPEED:g}")
        return float(speed)

    @property
    def speed(self) -> float:
        return self._speed

    @property
    def paused(self) -> bool:
        return self._paused

    def now(self) -> datetime:
        if self._paused:
            return self._anchor_sim
        elapsed = self._monotonic() - self._anchor_real
        return self._anchor_sim + timedelta(seconds=elapsed * self._speed)

    def now_iso(self) -> str:
        return iso(self.now())

    def state(self) -> dict:
        return {"sim_time": self.now_iso(), "speed": self._speed, "paused": self._paused}

    def on_change(self, listener: Callable[[dict], None]) -> None:
        """Called with the new state after any speed, pause or resume change."""
        self._listeners.append(listener)

    def _reanchor(self) -> None:
        self._anchor_sim = self.now()
        self._anchor_real = self._monotonic()

    def _changed(self) -> None:
        for event in list(self._waiters):
            event.set()
        state = self.state()
        for listener in self._listeners:
            listener(state)

    def set_speed(self, speed: float) -> None:
        speed = self._validate(speed)
        self._reanchor()
        self._speed = speed
        self._changed()

    def pause(self) -> None:
        if self._paused:
            return
        self._reanchor()
        self._paused = True
        self._changed()

    def resume(self) -> None:
        if not self._paused:
            return
        self._anchor_real = self._monotonic()
        self._paused = False
        self._changed()

    def jump(self, sim_seconds: float) -> None:
        """Move sim time forward instantly (demo reset and tests)."""
        self._anchor_sim += timedelta(seconds=sim_seconds)
        self._changed()

    async def _wait_for_change(self, timeout: float | None) -> None:
        event = asyncio.Event()
        self._waiters.add(event)
        try:
            await asyncio.wait_for(event.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            self._waiters.discard(event)

    async def sleep(self, sim_seconds: float) -> None:
        """Wait until sim time has advanced by `sim_seconds`, following speed changes."""
        await self.sleep_until(self.now() + timedelta(seconds=sim_seconds))

    async def sleep_until(self, target: datetime) -> None:
        while True:
            remaining = (target - self.now()).total_seconds()
            if remaining <= 0:
                return
            if self._paused:
                await self._wait_for_change(None)
            else:
                await self._wait_for_change(max(remaining / self._speed, 0.001))
