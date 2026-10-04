"""N drone runtimes in one process around an in-process edge, on a clock that can run fast.

Each drone is the real `DroneRuntime` with simulated flight; only the edge-connector is replaced
(by `LocalHub`). The camera is whatever the caller builds per drone.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .camera import CameraSpec
from .fleet import ring
from .flight.simulated import Kinematics, SimulatedFlight
from .geo import LatLng, LocalFrame
from .link.drone_info import DroneInfoForwarder
from .link.local import LocalHub
from .link.messages import Json
from .mission import FlightParams
from .nav.avoid import METRIC
from .perception.detector import Detector
from .runtime import DroneIdentity, DroneRuntime, hello
from .sensors import Camera

log = logging.getLogger(__name__)

# Small frames keep N drones rendering in real time on one laptop.
SIM_CAMERA = CameraSpec(160, 120, 84.0)


@dataclass
class SimReport:
    landed: bool
    sim_seconds: float
    coverage: float
    frames_with_risk: int
    min_separation_m: float
    per_drone: dict[str, Json] = field(default_factory=dict)


class ScaledClock:
    def __init__(self, scale: float) -> None:
        self.scale = scale
        self.start = time.monotonic()

    def __call__(self) -> float:
        return (time.monotonic() - self.start) * self.scale


def mission_json(center: LatLng, radius_m: float, swarm: list[str], cell_m: float = 10.0) -> Json:
    return {
        "runId": f"sim-{int(time.time())}",
        "zoneId": "sim-zone",
        "edgeServer": {"lat": center.lat, "lng": center.lng},
        "connectivityRadiusM": radius_m,
        "boundary": None,
        "cellSizeM": cell_m,
        "altitude": {"minM": 60.0, "maxM": 120.0},
        "swarm": swarm,
    }


async def run_swarm(
    drones: int,
    center: LatLng,
    radius_m: float,
    make_camera: Callable[[str, CameraSpec], Camera],
    detector: Detector,
    time_scale: float = 5.0,
    timeout_s: float = 600.0,
    spec: CameraSpec = SIM_CAMERA,
    progress: Callable[[str], None] | None = None,
    drone_info_url: str | None = None,
) -> SimReport:
    """Fly one run to the end. With `drone_info_url`, the in-process edge also posts what drones
    report to that drone-info, as edge-manager does, so viewers can watch."""
    clock = ScaledClock(time_scale)
    hub = LocalHub()
    forwarder = DroneInfoForwarder(drone_info_url) if drone_info_url else None
    local = LocalFrame(center)
    ids = [f"sim-{i + 1}" for i in range(drones)]
    params = FlightParams()
    min_sep = math.inf
    tasks = []
    for i, (drone_id, home) in enumerate(zip(ids, ring(center, drones), strict=True)):
        identity = DroneIdentity(
            drone_id, f"Sim {i + 1}", "simulated", params.max_speed_mps, 1500.0
        )
        camera = make_camera(drone_id, spec)
        runtime = DroneRuntime(
            identity,
            hub.link(drone_id, hello(identity, camera)),
            SimulatedFlight(Kinematics(home, max_speed_mps=params.max_speed_mps), clock),
            camera,
            detector,
            params,
            clock=clock,
            control_period_s=0.1 / time_scale,
            telemetry_period_s=max(0.05, min(0.1, 0.5 / time_scale)),
            swarm_period_s=max(0.02, 0.25 / time_scale),
            frame_period_s=0.5 / time_scale,
        )
        tasks.append(asyncio.create_task(runtime.run()))

    def watch(drone_id: str, msg: Json) -> None:
        nonlocal min_sep
        if forwarder is not None:
            forwarder.offer(msg)
        if msg["type"] != "telemetry":
            return
        mine = _xyz(local, msg)
        for other_id, other in hub.telemetry.items():
            if other_id != drone_id and mine[2] > 20 and _xyz(local, other)[2] > 20:
                gap = [
                    (a - b) * w for a, b, w in zip(mine, _xyz(local, other), METRIC, strict=True)
                ]
                min_sep = min(min_sep, math.hypot(*gap))

    hub.on_uplink = watch
    if forwarder is not None:
        tasks.append(asyncio.create_task(forwarder.run()))
    await asyncio.sleep(0.2)
    hub.start_mapping(mission_json(center, radius_m, ids))
    started = clock()
    landed = False
    try:
        for tick in itertools.count():
            await asyncio.sleep(0.5)
            statuses = [hub.status.get(d) for d in ids]
            landed = all(s is not None and s["phase"] == "landed" for s in statuses)
            if progress is not None and tick % 10 == 0:
                cov = max((_num(s["coverage"]) for s in statuses if s), default=0.0)
                phases = ",".join(str(s["phase"]) if s else "-" for s in statuses)
                elapsed = clock() - started
                progress(
                    f"t={elapsed:5.0f}s coverage {cov:5.1%} risk frames {_risky(hub)} [{phases}]"
                )
            if landed or clock() - started > timeout_s:
                break
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await t
        if forwarder is not None:
            await forwarder.flush()
    coverage = max((_num(s["coverage"]) for s in hub.status.values()), default=0.0)
    return SimReport(landed, clock() - started, coverage, _risky(hub), min_sep, dict(hub.status))


def _xyz(local: LocalFrame, telemetry: Json) -> tuple[float, float, float]:
    pose = telemetry["pose"]
    assert isinstance(pose, dict)
    x, y = local.point_xy(float(pose["lat"]), float(pose["lng"]))
    return x, y, float(pose["altM"])


def _num(value: object) -> float:
    return float(value) if isinstance(value, int | float) else 0.0


def _risky(hub: LocalHub) -> int:
    """Frames in which some drone found a risk."""
    return sum(1 for d in hub.detections if d["detections"])
