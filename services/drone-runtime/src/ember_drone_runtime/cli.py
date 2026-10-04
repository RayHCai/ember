"""`drone-runtime run` flies one drone for an edge-connector and `fleet` several; `swarm-sim` flies
N around an in-process edge."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from .camera import CameraSpec
from .fleet import fleet_members
from .flight.simulated import Kinematics, SimulatedFlight
from .geo import LatLng
from .link.discovery import discover_edge
from .link.edge import EdgeLink, Resolver
from .link.messages import DRONE_LINK_PATH
from .mission import FlightParams
from .perception import make_detector
from .perception.detector import Detector
from .runtime import DroneIdentity, DroneRuntime, hello
from .sensors import Camera
from .sensors.sensor_stream import SensorStreamCamera
from .sensors.synthetic import SyntheticCamera, SyntheticWorld, demo_world
from .swarm_sim import ScaledClock, run_swarm

# Lahaina, on the path the fire takes west from the Kuialua St rekindle (14:52 HST), inside Demo
# Data's coverage, so the sensor-stream camera sees fire within minutes of the clock starting.
DEFAULT_CENTER = "20.8838,-156.6670"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="drone-runtime")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="fly one drone for an edge-connector")
    run.add_argument("--id", default=os.environ.get("EMBER_DRONE_ID", "drone-1"))
    run.add_argument("--name", default=None)
    _edge_args(run, "lat,lng the simulated drone takes off from")

    fleet = sub.add_parser("fleet", help="fly several simulated drones for an edge-connector")
    fleet.add_argument("--drones", type=int, default=2)
    fleet.add_argument(
        "--id-prefix", default="sim", help="drone ids are <prefix>-1, <prefix>-2, ..."
    )
    _edge_args(fleet, "lat,lng the drones take off on a 12 m ring around")

    sim = sub.add_parser("swarm-sim", help="fly N drones around an in-process edge")
    sim.add_argument("--drones", type=int, default=3)
    sim.add_argument("--center", default=DEFAULT_CENTER, help="lat,lng of the edge server")
    sim.add_argument("--radius", type=float, default=300.0, help="connectivity radius in metres")
    sim.add_argument(
        "--time-scale",
        type=float,
        default=None,
        help="flight speed against the wall clock; default 5, or 1 with --drone-info",
    )
    sim.add_argument(
        "--drone-info",
        default=os.environ.get("EMBER_DRONE_INFO_URL"),
        help="post what drones report to this drone-info (e.g. http://localhost:4002), for viewers",
    )
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
        elif args.command == "fleet":
            asyncio.run(_fleet(args))
        else:
            asyncio.run(_swarm_sim(args))
    except KeyboardInterrupt:
        pass
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        sys.exit(f"drone-runtime: {exc}")


def _edge_args(p: argparse.ArgumentParser, home_help: str) -> None:
    p.add_argument(
        "--edge",
        default=os.environ.get("EMBER_EDGE_URL", "auto"),
        help=f"edge-connector URL (ws://host:8070{DRONE_LINK_PATH}), or auto to find one over mDNS",
    )
    p.add_argument(
        "--edge-id",
        default=os.environ.get("EMBER_EDGE_ID"),
        help="with --edge auto, connect only to this edge server id",
    )
    p.add_argument("--home", default=DEFAULT_CENTER, help=home_help)
    p.add_argument("--time-scale", type=float, default=1.0)
    _sensor_args(p)


def _sensor_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--camera",
        choices=["synthetic", "sensor-stream"],
        default=None,
        help="default synthetic; with --drone-info sensor-stream, the world viewers draw",
    )
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
    args: argparse.Namespace, drone_id: str, spec: CameraSpec, world: SyntheticWorld | None
) -> Camera:
    if world is None:
        return SensorStreamCamera(args.sensor_url, drone_id, spec)
    return SyntheticCamera(world, spec)


def _edge(args: argparse.Namespace) -> str | Resolver:
    if args.edge != "auto":
        return str(args.edge)
    edge_id: str | None = args.edge_id
    return lambda: discover_edge(edge_id)


def _world(args: argparse.Namespace, origin: LatLng) -> SyntheticWorld | None:
    return None if args.camera == "sensor-stream" else demo_world(origin, 3000.0)


def _runtime(
    args: argparse.Namespace,
    drone_id: str,
    name: str,
    home: LatLng,
    world: SyntheticWorld | None,
    detector: Detector,
) -> DroneRuntime:
    spec = CameraSpec(640, 480, 84.0)
    params = FlightParams()
    identity = DroneIdentity(drone_id, name, "simulated", params.max_speed_mps, 1500.0)
    camera = _camera(args, drone_id, spec, world)
    clock = ScaledClock(args.time_scale)
    return DroneRuntime(
        identity,
        EdgeLink(_edge(args), hello(identity, camera)),
        SimulatedFlight(Kinematics(home, max_speed_mps=params.max_speed_mps), clock),
        camera,
        detector,
        params,
        clock=clock,
        control_period_s=0.1 / args.time_scale,
        frame_period_s=0.5 / args.time_scale,
    )


async def _run(args: argparse.Namespace) -> None:
    home = _latlng(args.home)
    detector = make_detector(args.detector, args.yolo_model)
    await _runtime(args, args.id, args.name or args.id, home, _world(args, home), detector).run()


async def _fleet(args: argparse.Namespace) -> None:
    center = _latlng(args.home)
    members = fleet_members(args.id_prefix, args.drones, center)
    world = _world(args, center)
    detector = make_detector(args.detector, args.yolo_model)
    async with asyncio.TaskGroup() as tg:
        for m in members:
            tg.create_task(_runtime(args, m.drone_id, m.name, m.home, world, detector).run())


async def _swarm_sim(args: argparse.Namespace) -> None:
    center = _latlng(args.center)
    watched = bool(args.drone_info)
    camera = args.camera or ("sensor-stream" if watched else "synthetic")
    if watched and camera == "synthetic":
        print("note: viewers draw Demo Data's world; synthetic fires will not line up with it")
    world = demo_world(center, args.radius) if camera == "synthetic" else None

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
        time_scale=args.time_scale or (1.0 if watched else 5.0),
        timeout_s=args.timeout,
        progress=print,
        drone_info_url=args.drone_info,
    )
    print(
        f"{'all landed' if report.landed else 'timed out'} after {report.sim_seconds:.0f} s: "
        f"coverage {report.coverage:.1%}, {report.frames_with_risk} frames with risk, "
        f"closest approach {report.min_separation_m:.1f} m"
    )
