"""Camera fed by a remote sensor stream (the `/v1/stream` protocol Demo Data serves).

The drone sends its pose and gets back RGB and thermal frames rendered from it. No depth: the
stream's world is flat ground.
"""

from __future__ import annotations

import asyncio
import base64
import io
import itertools
import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import numpy as np
from PIL import Image
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from ..camera import CameraSpec, Images, Pose
from . import CameraError


class SensorStreamCamera:
    def __init__(
        self,
        url: str,
        drone_id: str,
        spec: CameraSpec,
        thermal_width: int | None = None,
        timeout_s: float = 15.0,
    ) -> None:
        self.url = url
        self.drone_id = drone_id
        self.spec = spec
        self.sensors = ["rgb", "thermal"]
        self.thermal_width = thermal_width or min(320, spec.width_px)
        self.timeout_s = timeout_s
        self._ws: ClientConnection | None = None
        self._ids = itertools.count(1)
        self._clock: tuple[datetime, float, float] | None = None

    async def _connect(self) -> ClientConnection:
        if self._ws is not None:
            return self._ws
        try:
            ws = await connect(
                self.url, open_timeout=self.timeout_s, close_timeout=1.0, max_size=32 * 2**20
            )
        except (OSError, WebSocketException, TimeoutError) as exc:
            raise CameraError(f"sensor stream {self.url}: {exc}") from exc
        await ws.send(
            json.dumps(
                {
                    "type": "configure",
                    "drone_id": self.drone_id,
                    "camera": {
                        "width": self.spec.width_px,
                        "height": self.spec.height_px,
                        "hfov_deg": self.spec.hfov_deg,
                    },
                    "thermal_width": self.thermal_width,
                    "images": self.sensors,
                    "truth": False,
                    "rate_hz": 0,
                }
            )
        )
        self._ws = ws
        return ws

    async def capture(self, pose: Pose) -> Images:
        ws = await self._connect()
        request_id = str(next(self._ids))
        msg: dict[str, Any] = {
            "type": "pose",
            "request_id": request_id,
            "lat": pose.lat,
            "lon": pose.lng,
            "alt_m": max(1.0, pose.alt_m),
            "heading_deg": pose.heading_deg % 360.0,
            "pitch_deg": min(30.0, max(-90.0, pose.pitch_deg)),
        }
        try:
            await ws.send(json.dumps(msg))
            deadline = time.monotonic() + self.timeout_s
            while True:
                raw = await _recv(ws, deadline - time.monotonic())
                reply = cast(dict[str, Any], json.loads(raw))
                kind = reply.get("type")
                if kind == "configured":
                    self._set_clock(
                        reply.get("clock", {}).get("scenario_time"),
                        reply.get("clock", {}).get("speed"),
                    )
                elif kind == "error" and reply.get("request_id") in (request_id, None):
                    raise CameraError(f"sensor stream: {reply.get('code')}: {reply.get('message')}")
                elif kind == "observation" and reply.get("request_id") == request_id:
                    return self._images(reply)
        except (WebSocketException, OSError, TimeoutError) as exc:
            # Closed, not just dropped: the server renders for every open socket's pending pose.
            self._ws = None
            await ws.close()
            why = str(exc) or "no observation in time"
            raise CameraError(f"sensor stream {self.url}: {why}") from exc
        except (KeyError, ValueError) as exc:
            raise CameraError(f"sensor stream {self.url}: bad observation: {exc}") from exc

    def scenario_clock(self) -> tuple[datetime | None, float]:
        if self._clock is None:
            return None, 1.0
        at, speed, wall = self._clock
        return at + timedelta(seconds=(time.monotonic() - wall) * speed), speed

    def _set_clock(self, iso: object, speed: object) -> None:
        if isinstance(iso, str):
            rate = float(speed) if isinstance(speed, int | float) else 1.0
            self._clock = (datetime.fromisoformat(iso), rate, time.monotonic())

    def _images(self, obs: dict[str, Any]) -> Images:
        images = obs.get("images", {})
        if "rgb" not in images:
            raise CameraError("sensor stream: observation without rgb")
        rgb = np.asarray(_decode(images["rgb"]).convert("RGB"), dtype=np.uint8)
        thermal = None
        if "thermal" in images:
            thermal = (np.asarray(_decode(images["thermal"]), dtype=np.float32) / 10.0).astype(
                np.float32
            )
        when = obs.get("scenario_time")
        at = datetime.fromisoformat(when) if isinstance(when, str) else None
        if at is not None:
            speed = self._clock[1] if self._clock else 1.0
            self._clock = (at, speed, time.monotonic())
        return Images(rgb=rgb, thermal_k=thermal, scenario_time=at or datetime.now(UTC))


def _decode(image: dict[str, Any]) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(image["data"])))


async def _recv(ws: ClientConnection, timeout: float) -> str | bytes:
    if timeout <= 0:
        raise TimeoutError("no observation in time")
    return await asyncio.wait_for(ws.recv(), timeout)
