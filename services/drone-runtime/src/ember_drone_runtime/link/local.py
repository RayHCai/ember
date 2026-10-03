"""In-process stand-in for edge-connector, for `swarm-sim` and tests.

It does what the connector's contract says and nothing more: answers `hello`, sends runs down,
relays `swarm` messages to the other drones of the run and keeps what drones report up. Every
message goes through JSON so the wire shapes are exercised.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from .edge import Handler
from .messages import Json, now_iso, parse_downlink


class LocalHub:
    def __init__(self, edge_server_id: str = "local-edge") -> None:
        self.edge_server_id = edge_server_id
        self.links: dict[str, LocalLink] = {}
        self.runs: dict[str, tuple[str, ...]] = {}
        self.hellos: dict[str, Json] = {}
        self.telemetry: dict[str, Json] = {}
        self.status: dict[str, Json] = {}
        self.detections: list[Json] = []
        self.on_uplink: Callable[[str, Json], None] | None = None

    def link(self, drone_id: str, hello: Json | None = None) -> LocalLink:
        link = LocalLink(self, drone_id, hello)
        self.links[drone_id] = link
        return link

    def start_mapping(self, mission: Json) -> None:
        swarm = mission["swarm"]
        assert isinstance(swarm, list)
        self.runs[str(mission["runId"])] = tuple(str(d) for d in swarm)
        for drone_id in swarm:
            self._down(str(drone_id), {"type": "start_mapping", "mission": mission})

    def stop_mapping(self, run_id: str) -> None:
        for drone_id in self.runs.get(run_id, ()):
            self._down(drone_id, {"type": "stop_mapping", "runId": run_id})

    def _down(self, drone_id: str, msg: Json) -> None:
        link = self.links.get(drone_id)
        if link is not None:
            link.inbox.put_nowait(json.dumps(msg))

    def _up(self, drone_id: str, raw: str) -> None:
        msg: dict[str, Any] = json.loads(raw)
        kind = msg["type"]
        if kind == "hello":
            self.hellos[drone_id] = msg
            self._down(
                drone_id,
                {"type": "welcome", "edgeServerId": self.edge_server_id, "serverTime": now_iso()},
            )
        elif kind == "swarm":
            msg["from"] = drone_id
            for other in self.runs.get(msg["runId"], ()):
                if other != drone_id:
                    self._down(other, msg)
        elif kind == "telemetry":
            self.telemetry[drone_id] = msg
        elif kind == "mission_status":
            self.status[drone_id] = msg
        elif kind == "detections":
            self.detections.append(msg)
        if self.on_uplink is not None:
            self.on_uplink(drone_id, msg)


class LocalLink:
    def __init__(self, hub: LocalHub, drone_id: str, hello: Json | None) -> None:
        self.hub = hub
        self.drone_id = drone_id
        self.inbox: asyncio.Queue[str] = asyncio.Queue()
        self.hello = hello
        self._up = False

    @property
    def connected(self) -> bool:
        return self._up

    async def send(self, msg: Json) -> None:
        if self._up:
            self.hub._up(self.drone_id, json.dumps(msg))

    async def run(self, handle: Handler) -> None:
        self._up = True
        if self.hello is not None:
            self.hub._up(self.drone_id, json.dumps(self.hello))
        try:
            while True:
                await handle(parse_downlink(json.loads(await self.inbox.get())))
        finally:
            self._up = False
