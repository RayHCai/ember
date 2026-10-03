"""The drone's side of the edge link: one WebSocket to its edge-connector, reconnected forever."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from .messages import Downlink, Json, LinkError, parse_downlink

log = logging.getLogger(__name__)

Handler = Callable[[Downlink], Awaitable[None]]


class Link(Protocol):
    @property
    def connected(self) -> bool: ...

    async def send(self, msg: Json) -> None:
        """Best effort: dropped while disconnected; everything sent is periodic or superseded."""
        ...

    async def run(self, handle: Handler) -> None: ...


class EdgeLink:
    def __init__(self, url: str, hello: Json, max_backoff_s: float = 10.0) -> None:
        self.url = url
        self.hello = hello
        self.max_backoff_s = max_backoff_s
        self._ws: ClientConnection | None = None

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def send(self, msg: Json) -> None:
        ws = self._ws
        if ws is None:
            return
        with contextlib.suppress(ConnectionClosed):
            await ws.send(json.dumps(msg))

    async def run(self, handle: Handler) -> None:
        backoff = 1.0
        while True:
            try:
                async with connect(
                    self.url, open_timeout=5, ping_interval=5, ping_timeout=10
                ) as ws:
                    await ws.send(json.dumps(self.hello))
                    self._ws = ws
                    backoff = 1.0
                    log.info("edge link: connected to %s", self.url)
                    async for raw in ws:
                        try:
                            msg = parse_downlink(json.loads(raw))
                        except (LinkError, ValueError) as exc:
                            log.warning("edge link: dropped message: %s", exc)
                            continue
                        await handle(msg)
            except (OSError, WebSocketException, TimeoutError) as exc:
                log.warning("edge link %s: %s; retrying in %.0f s", self.url, exc, backoff)
            finally:
                self._ws = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self.max_backoff_s)
