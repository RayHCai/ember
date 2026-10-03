"""In-process event bus.

Every event is `{kind, zone_id, ts, payload}` (CLAUDE.md, "Events"). Publishing
applies the event to the console state first, then fans it out to every
WebSocket subscriber. Publishing is safe from any thread: the agent may run
blocking work in a worker thread.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable

from .sim.clock import SimClock
from .state import ConsoleState

log = logging.getLogger(__name__)

SUBSCRIBER_QUEUE = 2000

# Put on a subscriber's queue when it falls behind, telling it to resync.
RESYNC: dict = {"kind": "_resync"}


def make_event(kind: str, zone_id: str, payload: dict, ts: str) -> dict:
    return {"kind": kind, "zone_id": zone_id, "ts": ts, "payload": payload}


class Subscriber:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE)
        self.dropped = False


class EventBus:
    def __init__(self, clock: SimClock, state: ConsoleState) -> None:
        self.clock = clock
        self.state = state
        self._subscribers: set[Subscriber] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: int | None = None
        self._taps: list[Callable[[dict], None]] = []

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._loop_thread = threading.get_ident()

    def tap(self, listener: Callable[[dict], None]) -> None:
        """Observe every published event (used by mirrors such as SpacetimeDB)."""
        self._taps.append(listener)

    def emit(self, kind: str, zone_id: str, payload: dict) -> dict:
        """Build an event stamped with sim time and publish it."""
        event = make_event(kind, zone_id, payload, self.clock.now_iso())
        self.publish(event)
        return event

    def publish(self, event: dict) -> None:
        if self._loop is not None and threading.get_ident() != self._loop_thread:
            self._loop.call_soon_threadsafe(self._publish, event)
        else:
            self._publish(event)

    def _publish(self, event: dict) -> None:
        self.state.apply(event)
        for tap in self._taps:
            try:
                tap(event)
            except Exception:  # a broken mirror must never stop the console
                log.exception("event tap failed")
        for sub in list(self._subscribers):
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                # The client cannot keep up. Drop it; it reconnects and gets a snapshot.
                sub.dropped = True
                self._subscribers.discard(sub)
                while not sub.queue.empty():
                    sub.queue.get_nowait()
                sub.queue.put_nowait(RESYNC)

    def subscribe(self) -> tuple[Subscriber, dict]:
        """Register a subscriber and return it with a snapshot event.

        Both happen with no await in between, so no event can fall in the gap.
        """
        sub = Subscriber()
        self._subscribers.add(sub)
        snapshot = make_event("snapshot", "*", self.state.snapshot(self.clock.state()), self.clock.now_iso())
        return sub, snapshot

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
