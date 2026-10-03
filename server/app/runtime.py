"""Process-wide runtime: the sim clock, console state, event bus and zones."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Coroutine
from typing import Any

from .bus import EventBus
from .sim.clock import SimClock
from .state import ConsoleState

log = logging.getLogger(__name__)


def default_speed() -> float:
    raw = os.environ.get("EMBER_SIM_SPEED", "").strip()
    if not raw:
        return 1.0
    try:
        return float(raw)
    except ValueError as err:
        raise ValueError(f"EMBER_SIM_SPEED must be a number, got {raw!r}") from err


class Runtime:
    def __init__(self, speed: float | None = None) -> None:
        self.clock = SimClock(speed if speed is not None else default_speed())
        self.state = ConsoleState()
        self.bus = EventBus(self.clock, self.state)
        self.clock.on_change(lambda sim: self.bus.emit("sim", "*", sim))
        self._tasks: set[asyncio.Task] = set()

    def spawn(self, coro: Coroutine[Any, Any, Any], name: str) -> asyncio.Task:
        """Run a background task and log it if it crashes."""
        task = asyncio.get_running_loop().create_task(coro, name=name)
        self._tasks.add(task)

        def done(t: asyncio.Task) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                log.error("background task %s failed", name, exc_info=t.exception())

        task.add_done_callback(done)
        return task

    async def start(self) -> None:
        self.bus.bind_loop(asyncio.get_running_loop())

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
