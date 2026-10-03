"""`drone-runtime run` flies one drone for an edge-connector; `swarm-sim` flies N in one process."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from .camera import CameraSpec
from .flight.simulated import Kinematics, SimulatedFlight
from .geo import LatLng
from .link.edge import EdgeLink
from .link.messages import DRONE_LINK_PATH
from .mission import FlightParams
from .perception import make_detector
from .runtime import DroneIdentity, DroneRuntime, hello
from .sensors import Camera
from .sensors.sensor_stream import SensorStreamCamera
from .sensors.synthetic import SyntheticCamera, demo_world
from .swarm_sim import ScaledClock, run_swarm

# Lahaina, inside Demo Data's coverage, so the sensor-stream camera works out of the box.
DEFAULT_CENTER = "20.8790,-156.6760"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="drone-runtime")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="fly one drone for an edge-connector")
    run.add_argument("--id", default=os.environ.get("EMBER_DRONE_ID", "drone-1"))
    run.add_argument("--name", default=None)
    run.add_argument(
        "--edge", default=os.environ.get("EMBER_EDGE_URL", f"ws://localhost:8070{DRONE_LINK_PATH}")
    )
    run.add_argument(
        "--home", default=DEFAULT_CENTER, help="lat,lng the simulated drone takes off from"
    )
    run.add_argument("--time-scale", type=float, default=1.0)
    _sensor_args(run)

    sim = sub.add_parser("swarm-sim", help="fly N drones around an in-process edge")
    sim.add_argument("--drones", type=int, default=3)
    sim.add_argument("--center", default=DEFAULT_CENTER, help="lat,lng of the edge server")
    sim.add_argument("--radius", type=float, default=300.0, help="connectivity radius in metres")
    sim.add_argument("--time-scale", type=float, default=5.0)
    sim.add_argument(
        "--timeout", type=float, default=900.0, help="simulated seconds before giving up"
    )
    _sensor_args(sim)

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        if args.command == "run":
            asyncio.run(_run(args))
        else:
            asyncio.run(_swarm_sim(args))
    except KeyboardInterrupt:
        pass
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        sys.exit(f"drone-runtime: {exc}")


def _sensor_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--camera", choices=["synthetic", "sensor-stream"], default="synthetic")
    p.add_argument(
        "--sensor-url",
        default=os.environ.get("EMBER_SENSOR_URL", "ws://localhost:8090/v1/stream"),
        help="sensor stream for --camera sensor-stream (Demo Data)",
    )
    p.add_argument("--detector", choices=["auto", "yolo", "heuristic"], default="auto")
    p.add_argument("--yolo-model", type=Path, default=_env_path("EMBER_YOLO_MODEL"))


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name)
    return Path(value) if value else None


def _latlng(text: str) -> LatLng:
    try:
        lat, lng = (float(v) for v in text.split(","))
    except ValueError as exc:
        raise ValueError(f"expected lat,lng, got {text!r}") from exc
    return LatLng(lat, lng)


def _camera(
    args: argparse.Namespace, drone_id: str, spec: CameraSpec, origin: LatLng, radius_m: float
) -> Camera:
    if args.camera == "sensor-stream":
        return SensorStreamCamera(args.sensor_url, drone_id, spec)
    return SyntheticCamera(demo_world(origin, radius_m), spec)


async def _run(args: argparse.Namespace) -> None:
    home = _latlng(args.home)
    spec = CameraSpec(640, 480, 84.0)
    params = FlightParams()
    identity = DroneIdentity(
        args.id, args.name or args.id, "simulated", params.max_speed_mps, 1500.0
    )
    camera = _camera(args, args.id, spec, home, 3000.0)
    clock = ScaledClock(args.time_scale)
    runtime = DroneRuntime(
        identity,
        EdgeLink(args.edge, hello(identity, camera)),
        SimulatedFlight(Kinematics(home, max_speed_mps=params.max_speed_mps), clock),
        camera,
        make_detector(args.detector, args.yolo_model),
        params,
        clock=clock,
        control_period_s=0.1 / args.time_scale,
    )
    await runtime.run()


async def _swarm_sim(args: argparse.Namespace) -> None:
    center = _latlng(args.center)
    world = None
    if args.camera == "synthetic":
        world = demo_world(center, args.radius)

    def make_camera(drone_id: str, spec: CameraSpec) -> Camera:
        if world is not None:
            return SyntheticCamera(world, spec)
        return SensorStreamCamera(args.sensor_url, drone_id, spec)

    report = await run_swarm(
        args.drones,
        center,
        args.radius,
        make_camera,
        make_detector(args.detector, args.yolo_model),
        time_scale=args.time_scale,
        timeout_s=args.timeout,
        progress=print,
    )
    print(
        f"{'all landed' if report.landed else 'timed out'} after {report.sim_seconds:.0f} s: "
        f"coverage {report.coverage:.1%}, {report.frames_with_risk} frames with risk, "
        f"closest approach {report.min_separation_m:.1f} m"
    )
