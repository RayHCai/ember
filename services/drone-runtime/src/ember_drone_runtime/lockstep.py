"""Deterministic swarm simulation: brains, kinematics and a synchronous camera stepped together.

Swarm messages still go through the wire format, so this exercises everything `DroneRuntime` does
except sockets and timing jitter. Used by tests and for quick what-if runs.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import numpy as np

from .camera import CameraSpec, Frame, Images, Pose
from .flight.simulated import Kinematics
from .geo import LatLng
from .link import messages as wire
from .link.messages import Mission, SwarmIn, parse_downlink
from .mission import FlightParams, MissionBrain
from .nav.avoid import METRIC
from .perception.detector import Detector
from .perception.georef import RiskDetection

Render = Callable[[Pose, CameraSpec], Images]


@dataclass
class Drone:
    drone_id: str
    brain: MissionBrain
    body: Kinematics
    detections: list[RiskDetection] = field(default_factory=list)


@dataclass
class LockstepReport:
    seconds: float
    landed: bool
    coverage: float
    # Closest pair while both were above 20 m, vertical gaps counted double as in avoidance.
    min_separation_m: float
    max_radius_m: float
    detections: list[RiskDetection]


class Lockstep:
    def __init__(
        self,
        mission: Mission,
        homes: list[tuple[str, float, float]],
        render: Render,
        detector: Detector,
        spec: CameraSpec,
        params: FlightParams | None = None,
    ) -> None:
        self.mission = mission
        self.render = render
        self.detector = detector
        self.spec = spec
        self.params = params or FlightParams()
        self.t = 0.0
        self.frame_id = 0
        self.drones: list[Drone] = []
        for drone_id, lat, lng in homes:
            brain = MissionBrain(drone_id, mission, spec, self.params, 0.0)
            body = Kinematics(LatLng(lat, lng), max_speed_mps=self.params.max_speed_mps)
            self.drones.append(Drone(drone_id, brain, body))

    def run(
        self, seconds: float, dt: float = 0.1, swarm_s: float = 0.25, frame_s: float = 1.0
    ) -> LockstepReport:
        min_sep, max_r = math.inf, 0.0
        steps = int(seconds / dt)
        every_swarm = max(1, round(swarm_s / dt))
        every_frame = max(1, round(frame_s / dt))
        for step in range(steps):
            self.t = step * dt
            for d in self.drones:
                vs = d.body.state()
                d.brain.link_contact(self.t)
                cmd = d.brain.control(self.t, vs)
                if cmd.action == "takeoff":
                    d.body.takeoff()
                    d.body.command(np.array([0.0, 0.0, d.body.max_climb_mps]), d.body.heading_deg)
                elif cmd.action == "land":
                    d.body.land()
                else:
                    d.body.command(np.array(cmd.velocity), cmd.heading_deg)
                d.body.step(dt)
            if step % every_swarm == 0:
                self._exchange(coverage=step % (every_swarm * 4) == 0)
            if step % every_frame == 0:
                self._capture()
            pos = [
                d.brain.position
                for d in self.drones
                if d.body.airborne and d.brain.position[2] > 20
            ]
            for i, a in enumerate(pos):
                max_r = max(max_r, float(np.hypot(a[0], a[1])))
                for b in pos[i + 1 :]:
                    min_sep = min(min_sep, float(np.linalg.norm((a - b) * METRIC)))
            if all(d.brain.phase == "landed" for d in self.drones):
                break
        return LockstepReport(
            seconds=self.t,
            landed=all(d.brain.phase == "landed" for d in self.drones),
            coverage=max(d.brain.coverage() for d in self.drones),
            min_separation_m=min_sep,
            max_radius_m=max_r,
            detections=[r for d in self.drones for r in d.detections],
        )

    def _exchange(self, coverage: bool) -> None:
        run = self.mission.run_id
        outbox = []
        for d in self.drones:
            vs = d.body.state()
            outbox.append(wire.swarm_state(run, d.drone_id, d.brain.state_message(vs)))
            fresh = d.brain.coverage_message() if coverage else None
            if fresh is not None:
                outbox.append(wire.swarm_coverage(run, d.drone_id, fresh))
        for raw in outbox:
            msg = parse_downlink(json.loads(json.dumps(raw)))
            assert isinstance(msg, SwarmIn)
            for d in self.drones:
                if d.drone_id != msg.sender:
                    d.brain.on_swarm(msg, self.t)

    def _capture(self) -> None:
        for d in self.drones:
            if not d.body.airborne or d.brain.phase == "landed":
                continue
            pose = d.brain.wire_pose(d.body.state())
            if pose.alt_m < 5.0:
                continue
            self.frame_id += 1
            frame = Frame(
                self.frame_id, datetime.now(UTC), pose, self.spec, self.render(pose, self.spec)
            )
            d.detections.extend(d.brain.on_frame(frame, self.detector.detect(frame)))
