"""The async shell around `MissionBrain`: devices in, link out, on fixed rates."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from .camera import Frame, Pose
from .flight import FlightController, VehicleState
from .link import messages as wire
from .link.edge import Link
from .link.messages import (
    Downlink,
    DroneMode,
    Json,
    Phase,
    StartMapping,
    StopMapping,
    SwarmIn,
    Welcome,
)
from .mission import FlightParams, MissionBrain
from .perception.detector import Detector
from .sensors import Camera, CameraError

log = logging.getLogger(__name__)

MODE: dict[Phase, DroneMode] = {
    "takeoff": "patrol",
    "mapping": "patrol",
    "returning": "returning",
    "landing": "returning",
    "landed": "landed",
}
# Below this a simulated camera has nothing useful to show and Demo Data rejects the pose.
MIN_CAPTURE_ALT_M = 5.0


@dataclass(frozen=True)
class DroneIdentity:
    drone_id: str
    name: str
    kind: Literal["simulated", "physical"]
    max_speed_mps: float
    endurance_s: float


def hello(identity: DroneIdentity, camera: Camera) -> Json:
    return wire.hello(
        identity.drone_id,
        identity.name,
        identity.kind,
        camera.spec,
        camera.sensors,
        identity.max_speed_mps,
        identity.endurance_s,
    )


class DroneRuntime:
    def __init__(
        self,
        identity: DroneIdentity,
        link: Link,
        flight: FlightController,
        camera: Camera,
        detector: Detector,
        params: FlightParams | None = None,
        clock: Callable[[], float] = time.monotonic,
        control_period_s: float = 0.1,
        telemetry_period_s: float = 0.5,
        swarm_period_s: float = 0.25,
        frame_period_s: float = 0.5,
    ) -> None:
        self.identity = identity
        self.link = link
        self.flight = flight
        self.camera = camera
        self.detector = detector
        self.params = params or FlightParams(max_speed_mps=identity.max_speed_mps)
        self.clock = clock
        self.control_period_s = control_period_s
        self.telemetry_period_s = telemetry_period_s
        self.swarm_period_s = swarm_period_s
        # Frames at most this often: an on-board detector's pace, and a sensor stream's load.
        self.frame_period_s = frame_period_s
        self.brain: MissionBrain | None = None
        self.frame_id = 0
        self._vehicle: VehicleState | None = None

    async def run(self) -> None:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self.link.run(self._on_message))
            tg.create_task(self._control_loop())
            tg.create_task(self._perception_loop())
            tg.create_task(self._telemetry_loop())
            tg.create_task(self._swarm_loop())

    async def _on_message(self, msg: Downlink) -> None:
        now = self.clock()
        if isinstance(msg, Welcome):
            log.info("%s: paired with edge server %s", self.identity.drone_id, msg.edge_server_id)
        elif isinstance(msg, StartMapping):
            current = self.brain
            if current is not None and current.phase != "landed":
                if current.mission.run_id != msg.mission.run_id:
                    log.warning(
                        "%s: ignoring run %s, still in run %s",
                        self.identity.drone_id,
                        msg.mission.run_id,
                        current.mission.run_id,
                    )
                return
            try:
                self.brain = MissionBrain(
                    self.identity.drone_id, msg.mission, self.camera.spec, self.params, now
                )
            except ValueError as exc:
                log.error(
                    "%s: run %s rejected: %s", self.identity.drone_id, msg.mission.run_id, exc
                )
                return
            log.info("%s: starting run %s", self.identity.drone_id, msg.mission.run_id)
        elif isinstance(msg, StopMapping):
            if self.brain is not None and self.brain.mission.run_id == msg.run_id:
                self.brain.stop("stopped by edge")
        elif isinstance(msg, SwarmIn) and self.brain is not None:
            self.brain.on_swarm(msg, now)

    async def _control_loop(self) -> None:
        last_phase: Phase | None = None
        while True:
            vs = await self.flight.state()
            self._vehicle = vs
            brain = self.brain
            if brain is not None:
                now = self.clock()
                if self.link.connected:
                    brain.link_contact(now)
                cmd = brain.control(now, vs)
                if cmd.action == "takeoff":
                    await self.flight.takeoff(brain.cruise_agl_m)
                elif cmd.action == "land":
                    await self.flight.land()
                else:
                    await self.flight.command(cmd.velocity, cmd.heading_deg)
                await self.flight.set_gimbal_pitch(cmd.gimbal_pitch_deg)
                if brain.phase != last_phase:
                    why = (
                        f" ({brain.reason})" if brain.phase == "returning" and brain.reason else ""
                    )
                    log.info("%s: %s%s", self.identity.drone_id, brain.phase, why)
                    last_phase = brain.phase
            await asyncio.sleep(self.control_period_s)

    async def _perception_loop(self) -> None:
        while True:
            brain, vs = self.brain, self._vehicle
            if brain is None or vs is None or not vs.airborne or brain.phase == "landed":
                await asyncio.sleep(0.2)
                continue
            pose = brain.wire_pose(vs)
            if pose.alt_m < MIN_CAPTURE_ALT_M:
                await asyncio.sleep(0.2)
                continue
            started = time.monotonic()
            try:
                images = await self.camera.capture(pose)
            except CameraError as exc:
                log.warning("%s: %s", self.identity.drone_id, exc)
                await asyncio.sleep(1.0)
                continue
            self.frame_id += 1
            frame = Frame(self.frame_id, datetime.now(UTC), pose, self.camera.spec, images)
            found = await asyncio.to_thread(self.detector.detect, frame)
            if self.brain is not brain:
                continue
            risks = brain.on_frame(frame, found)
            scenario = (images.scenario_time or frame.captured_at).isoformat()
            await self.link.send(
                wire.detections(
                    self.identity.drone_id,
                    frame.frame_id,
                    frame.captured_at.isoformat(),
                    scenario,
                    pose,
                    frame.camera,
                    self.detector.name,
                    risks,
                )
            )
            await asyncio.sleep(max(0.0, self.frame_period_s - (time.monotonic() - started)))

    async def _telemetry_loop(self) -> None:
        ticks = 0
        while True:
            await asyncio.sleep(self.telemetry_period_s)
            vs = self._vehicle
            if vs is None:
                continue
            brain = self.brain
            if brain is not None:
                pose = brain.wire_pose(vs)
                mode: DroneMode = MODE[brain.phase]
            else:
                pose = Pose(vs.lat, vs.lng, vs.z_m, vs.heading_deg, self.params.gimbal_pitch_deg)
                mode = "patrol" if vs.airborne else "idle"
            at, speed = self.camera.scenario_clock()
            await self.link.send(
                wire.telemetry(
                    self.identity.drone_id,
                    at.isoformat() if at else None,
                    speed,
                    pose,
                    self.camera.spec,
                    vs.velocity_enu,
                    vs.battery_pct,
                    mode,
                )
            )
            ticks += 1
            if brain is not None and ticks % 2 == 0:
                await self.link.send(
                    wire.mission_status(
                        self.identity.drone_id,
                        brain.mission.run_id,
                        brain.phase,
                        brain.coverage(),
                        brain.detections_total,
                    )
                )

    async def _swarm_loop(self) -> None:
        ticks = 0
        while True:
            await asyncio.sleep(self.swarm_period_s)
            brain, vs = self.brain, self._vehicle
            if brain is None or vs is None:
                continue
            run, me = brain.mission.run_id, self.identity.drone_id
            await self.link.send(wire.swarm_state(run, me, brain.state_message(vs)))
            ticks += 1
            if ticks % 4 == 0:
                fresh = brain.coverage_message()
                if fresh is not None:
                    await self.link.send(wire.swarm_coverage(run, me, fresh))
