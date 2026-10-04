"""Stand-in for edge-manager in `swarm-sim`: posts what drones report to drone-info's ingest route.

Same route and shape edge-manager uses (`DroneInfoIngest` in packages/contracts), so drone-info
cannot tell them apart. Only `hello`, `telemetry` and `detections` go up.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.request
from typing import cast

from .messages import DRONE_INFO_INGEST_PATH, Json

log = logging.getLogger(__name__)

FORWARDED = frozenset({"hello", "telemetry", "detections"})
# Messages kept while drone-info is unreachable; the oldest go first.
MAX_PENDING = 5000


class DroneInfoForwarder:
    def __init__(self, base_url: str, period_s: float = 0.2, hello_every_s: float = 5.0) -> None:
        self.url = base_url.rstrip("/") + DRONE_INFO_INGEST_PATH
        self.period_s = period_s
        self.hello_every_s = hello_every_s
        self._pending: list[Json] = []
        self._hellos: dict[str, Json] = {}
        self._hello_sent_at = -float("inf")
        self._failing = False

    def offer(self, msg: Json) -> None:
        kind = msg.get("type")
        if kind not in FORWARDED:
            return
        if kind == "hello":
            self._hellos[str(msg["droneId"])] = msg
            return
        self._pending.append(msg)
        del self._pending[:-MAX_PENDING]

    async def run(self) -> None:
        while True:
            await asyncio.sleep(self.period_s)
            await self.flush()

    async def flush(self) -> None:
        batch, self._pending = self._pending, []
        now = time.monotonic()
        # Hellos are resent now and then, so a restarted drone-info learns names and kinds again.
        if self._hellos and now - self._hello_sent_at >= self.hello_every_s:
            batch = [*self._hellos.values(), *batch]
            self._hello_sent_at = now
        if not batch:
            return
        try:
            result = await asyncio.to_thread(self._post, batch)
        except (OSError, ValueError) as exc:
            if not self._failing:
                log.warning("drone-info %s: %s; dropping reports until it answers", self.url, exc)
            self._failing = True
            self._hello_sent_at = -float("inf")
            return
        if self._failing:
            log.info("drone-info %s: reachable again", self.url)
        self._failing = False
        rejected = result.get("rejected")
        if isinstance(rejected, int) and rejected:
            log.warning("drone-info rejected %d messages: %s", rejected, result.get("errors"))

    def _post(self, batch: list[Json]) -> Json:
        body = json.dumps({"messages": batch}).encode()
        req = urllib.request.Request(
            self.url, data=body, headers={"content-type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            return cast(Json, json.loads(res.read()))
