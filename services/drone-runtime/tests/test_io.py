import asyncio
import base64
import contextlib
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import numpy as np
import pytest
from ember_drone_runtime.camera import CameraSpec, Pose
from ember_drone_runtime.flight.simulated import Kinematics, SimulatedFlight
from ember_drone_runtime.geo import LatLng
from ember_drone_runtime.link.drone_info import DroneInfoForwarder
from ember_drone_runtime.link.edge import EdgeLink
from ember_drone_runtime.link.local import LocalHub
from ember_drone_runtime.link.messages import Downlink, Json, StartMapping, SwarmIn, Welcome
from ember_drone_runtime.mission import FlightParams
from ember_drone_runtime.perception import HeuristicDetector
from ember_drone_runtime.runtime import DroneIdentity, DroneRuntime, hello
from ember_drone_runtime.sensors import CameraError
from ember_drone_runtime.sensors.sensor_stream import SensorStreamCamera
from ember_drone_runtime.sensors.synthetic import SyntheticCamera, demo_world
from ember_drone_runtime.swarm_sim import ScaledClock, mission_json
from PIL import Image
from websockets.asyncio.server import ServerConnection, serve

EDGE = LatLng(20.879, -156.676)


def test_runtime_flies_a_run_end_to_end_over_the_link() -> None:
    async def scenario() -> tuple[LocalHub, list[str]]:
        scale = 20.0
        clock = ScaledClock(scale)
        hub = LocalHub()
        identity = DroneIdentity("solo", "Solo", "simulated", 10.0, 1500.0)
        camera = SyntheticCamera(demo_world(EDGE, 120.0), CameraSpec(96, 72, 84.0))
        runtime = DroneRuntime(
            identity,
            hub.link("solo", hello(identity, camera)),
            SimulatedFlight(Kinematics(EDGE), clock),
            camera,
            HeuristicDetector(),
            FlightParams(),
            clock=clock,
            control_period_s=0.1 / scale,
            telemetry_period_s=0.5 / scale,
            swarm_period_s=0.25 / scale,
        )
        modes: list[str] = []
        hub.on_uplink = lambda _, m: (
            modes.append(str(m["mode"])) if m["type"] == "telemetry" else None
        )
        task = asyncio.create_task(runtime.run())
        await asyncio.sleep(0.1)
        hub.start_mapping(mission_json(EDGE, 120.0, ["solo"]))
        for _ in range(1200):
            await asyncio.sleep(0.05)
            if hub.status.get("solo", {}).get("phase") == "landed":
                break
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return hub, modes

    hub, modes = asyncio.run(scenario())
    assert hub.hellos["solo"]["sensors"] == ["rgb", "thermal", "depth"]
    status = hub.status["solo"]
    assert status["phase"] == "landed"
    assert isinstance(status["coverage"], float) and status["coverage"] >= 0.97
    seen = [m for i, m in enumerate(modes) if i == 0 or modes[i - 1] != m]
    assert seen[-3:] == ["patrol", "returning", "landed"]
    assert any(d["detections"] for d in hub.detections)


async def _serve(handler: Any) -> tuple[Any, str]:
    server = await serve(handler, "127.0.0.1", 0)
    port = next(iter(server.sockets)).getsockname()[1]
    return server, f"ws://127.0.0.1:{port}"


def test_edge_link_says_hello_and_hands_on_valid_messages() -> None:
    mission = mission_json(EDGE, 300.0, ["drone-1", "drone-2"])

    async def scenario() -> tuple[list[Json], list[Downlink]]:
        heard: list[Json] = []

        async def connector(ws: ServerConnection) -> None:
            heard.append(json.loads(await ws.recv()))
            await ws.send(
                json.dumps({"type": "welcome", "edgeServerId": "edge-7", "serverTime": "t"})
            )
            await ws.send(json.dumps({"type": "start_mapping", "mission": mission}))
            await ws.send("not json")
            await ws.send(json.dumps({"type": "start_mapping", "mission": {}}))
            payload = {"kind": "coverage", "cells": [4], "topM": [None]}
            await ws.send(
                json.dumps({"type": "swarm", "runId": "r", "from": "drone-2", "payload": payload})
            )
            heard.append(json.loads(await ws.recv()))

        server, url = await _serve(connector)
        got: list[Downlink] = []
        link = EdgeLink(url, {"type": "hello", "droneId": "drone-1"})

        async def handle(msg: Downlink) -> None:
            got.append(msg)
            if isinstance(msg, SwarmIn):
                await link.send({"type": "telemetry", "droneId": "drone-1"})

        task = asyncio.create_task(link.run(handle))
        for _ in range(100):
            await asyncio.sleep(0.02)
            if len(heard) == 2:
                break
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        server.close()
        return heard, got

    heard, got = asyncio.run(scenario())
    assert heard == [
        {"type": "hello", "droneId": "drone-1"},
        {"type": "telemetry", "droneId": "drone-1"},
    ]
    assert [type(m) for m in got] == [Welcome, StartMapping, SwarmIn]


def test_edge_link_resolves_again_on_every_connect() -> None:
    async def scenario() -> tuple[int, list[Json]]:
        heard: list[Json] = []

        async def connector(ws: ServerConnection) -> None:
            heard.append(json.loads(await ws.recv()))

        server, live = await _serve(connector)
        urls = iter(["ws://127.0.0.1:1", live])
        asked = 0

        async def resolve() -> str:
            nonlocal asked
            asked += 1
            return next(urls, live)

        link = EdgeLink(resolve, {"type": "hello", "droneId": "drone-1"})

        async def ignore(msg: Downlink) -> None:
            pass

        task = asyncio.create_task(link.run(ignore))
        for _ in range(150):
            await asyncio.sleep(0.02)
            if heard:
                break
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        server.close()
        return asked, heard

    asked, heard = asyncio.run(scenario())
    assert asked == 2
    assert heard == [{"type": "hello", "droneId": "drone-1"}]


def _b64(img: Image.Image, fmt: str) -> str:
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def test_sensor_stream_camera_decodes_frames() -> None:
    poses: list[dict[str, Any]] = []

    async def stream(ws: ServerConnection) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "configure":
                clock = {"scenario_time": "2023-08-08T16:00:00-10:00", "speed": 60}
                await ws.send(json.dumps({"type": "configured", "config": {}, "clock": clock}))
            elif msg["lat"] > 50:
                error = {"type": "error", "code": "out_of_coverage", "message": "far"}
                await ws.send(json.dumps({**error, "request_id": msg["request_id"]}))
            else:
                poses.append(msg)
                rgb = Image.fromarray(np.full((48, 64, 3), 200, dtype=np.uint8))
                thermal = Image.fromarray(np.full((24, 32), 3005, dtype=np.uint16))
                await ws.send(
                    json.dumps(
                        {
                            "type": "observation",
                            "request_id": msg["request_id"],
                            "scenario_time": "2023-08-08T16:30:00-10:00",
                            "images": {
                                "rgb": {
                                    "format": "jpeg",
                                    "encoding": "base64",
                                    "data": _b64(rgb, "JPEG"),
                                },
                                "thermal": {
                                    "format": "png16_decikelvin",
                                    "encoding": "base64",
                                    "data": _b64(thermal, "PNG"),
                                },
                            },
                        }
                    )
                )

    async def scenario() -> None:
        server, url = await _serve(stream)
        camera = SensorStreamCamera(url, "drone-1", CameraSpec(64, 48, 84.0), thermal_width=32)
        images = await camera.capture(Pose(EDGE.lat, EDGE.lng, 0.2, 370.0, -95.0))
        assert images.rgb.shape == (48, 64, 3)
        assert images.thermal_k is not None and np.allclose(images.thermal_k, 300.5)
        assert images.scenario_time is not None and images.scenario_time.hour == 16
        at, speed = camera.scenario_clock()
        assert speed == 60 and at is not None and at.minute >= 30
        # Poses are clamped to what the stream accepts.
        sent = poses[0]
        assert (sent["lon"], sent["alt_m"], sent["heading_deg"], sent["pitch_deg"]) == (
            EDGE.lng,
            1.0,
            10.0,
            -90.0,
        )
        with pytest.raises(CameraError, match="out_of_coverage"):
            await camera.capture(Pose(60.0, 0.0, 100.0, 0.0, -90.0))
        server.close()

    asyncio.run(scenario())


def test_forwarder_posts_reports_to_drone_info_like_edge_manager() -> None:
    batches: list[dict[str, Any]] = []

    class Ingest(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            batches.append({"path": self.path, **body})
            out = json.dumps({"accepted": len(body["messages"]), "rejected": 0, "errors": []})
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(out.encode())

        def log_message(self, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Ingest)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    forwarder = DroneInfoForwarder(f"http://127.0.0.1:{server.server_port}/")
    forwarder.offer({"type": "telemetry", "droneId": "d1"})
    forwarder.offer({"type": "swarm", "runId": "r", "from": "d1", "payload": {}})
    forwarder.offer({"type": "mission_status", "droneId": "d1"})
    forwarder.offer({"type": "hello", "droneId": "d1"})
    asyncio.run(forwarder.flush())
    forwarder.offer({"type": "detections", "droneId": "d1"})
    asyncio.run(forwarder.flush())
    asyncio.run(forwarder.flush())
    server.shutdown()
    assert [b["path"] for b in batches] == ["/v1/ingest", "/v1/ingest"]
    assert [[m["type"] for m in b["messages"]] for b in batches] == [
        ["hello", "telemetry"],
        ["detections"],
    ]
