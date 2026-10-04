"""One drone's part in a mapping run: phases, goals, steering, failsafes.

Pure and synchronous: it takes vehicle state, frames, detections and swarm messages with the time
they arrived, and returns commands and messages. `DroneRuntime` moves the data; tests drive it in
lockstep.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Literal

import numpy as np

from .camera import CameraSpec, Frame, Pose
from .flight import VehicleState
from .geo import FloatArray, LocalFrame
from .link.messages import Mission, PeerCoverage, PeerState, Phase, SwarmIn, now_iso
from .mapping.evidence import EvidenceParams
from .mapping.grid import MissionGrid
from .mapping.integrate import integrate_frame
from .nav.avoid import avoid, contain
from .nav.path import Terrain, plan
from .perception.detector import Detection2D
from .perception.georef import RiskDetection, georeference
from .swarm.goals import Agent, GoalTile, TilePlan, assign
from .swarm.peers import PeerTable

Action = Literal["takeoff", "land"]


@dataclass(frozen=True)
class FlightParams:
    cruise_speed_mps: float = 8.0
    max_speed_mps: float = 10.0
    max_climb_mps: float = 3.0
    # Altitude band between drones of a run, so most pairs never share a height.
    band_spacing_m: float = 10.0
    clearance_m: float = 15.0
    # Assumed height of anything not yet measured (tall forest canopy).
    unknown_height_m: float = 35.0
    geofence_margin_m: float = 30.0
    safe_separation_m: float = 15.0
    avoid_horizon_s: float = 6.0
    map_range_m: float = 250.0
    georef_range_m: float = 2000.0
    coverage_target: float = 0.97
    replan_s: float = 4.0
    link_timeout_s: float = 20.0
    battery_reserve_pct: float = 15.0
    gimbal_pitch_deg: float = -90.0
    waypoint_tolerance_m: float = 8.0
    evidence: EvidenceParams = field(default_factory=EvidenceParams)


@dataclass(frozen=True)
class Command:
    velocity: tuple[float, float, float]
    heading_deg: float
    gimbal_pitch_deg: float
    action: Action | None = None


class MissionBrain:
    def __init__(
        self, drone_id: str, mission: Mission, camera: CameraSpec, params: FlightParams, now: float
    ) -> None:
        self.drone_id = drone_id
        self.mission = mission
        self.p = params
        self.local = LocalFrame(mission.edge_server)
        boundary = (
            None
            if mission.boundary is None
            else np.array([self.local.point(q) for q in mission.boundary])
        )
        self.grid = MissionGrid(
            mission.connectivity_radius_m,
            mission.cell_size_m,
            params.geofence_margin_m,
            boundary,
            params.evidence,
        )
        self.terrain = Terrain(self.grid, params.clearance_m, params.unknown_height_m)
        members = sorted(set(mission.swarm) | {drone_id})
        rank = members.index(drone_id)
        bands = max(1, int((mission.alt_max_m - mission.alt_min_m) // params.band_spacing_m) + 1)
        self.cruise_agl_m = mission.alt_min_m + (rank % bands) * params.band_spacing_m
        w, h = camera.footprint_m(mission.alt_min_m)
        self.tiles = TilePlan(self.grid, max(mission.cell_size_m, 0.8 * min(w, h)))
        self.peers = PeerTable(mission.swarm, drone_id)
        self.phase: Phase = "takeoff"
        self.reason = ""
        self.position = np.zeros(3)
        self.velocity = np.zeros(3)
        self.heading_deg = 0.0
        self.home: FloatArray | None = None
        self.home_ground_z = 0.0
        self.goal: GoalTile | None = None
        self.waypoints: list[FloatArray] = []
        self.unreachable: dict[int, float] = {}
        self.replan_at = 0.0
        self.last_link = now
        self.detections_total = 0
        self._battery_start: tuple[float, float] | None = None

    # --- inputs -----------------------------------------------------------------------------

    def link_contact(self, now: float) -> None:
        self.last_link = now

    def on_swarm(self, msg: SwarmIn, now: float) -> None:
        if msg.run_id != self.mission.run_id or msg.sender == self.drone_id:
            return
        if isinstance(msg.payload, PeerState):
            self.peers.update(msg.sender, msg.payload, now)
        elif msg.sender in self.peers.members:
            self.grid.merge(msg.payload)

    def on_frame(self, frame: Frame, found: list[Detection2D]) -> list[RiskDetection]:
        """Fold a frame and its detections into the grid. Returns the confirmed detections, each
        with its cells' posterior as confidence."""
        x, y = self.local.point_xy(frame.pose.lat, frame.pose.lng)
        ground = self.grid.ground_at(x, y)
        cam = np.array([x, y, ground + frame.pose.alt_m])
        seen = integrate_frame(self.grid, frame, cam, ground, self.p.map_range_m)
        located = [
            georeference(
                d,
                f"{self.drone_id}-{frame.frame_id}-{i}",
                frame,
                cam,
                ground,
                self.local,
                self.p.georef_range_m,
            )
            for i, d in enumerate(found)
        ]
        under = [self.grid.cells_under(r.outline_xy) for r in located]
        evidence = self.grid.evidence
        evidence.update(
            seen, [(r.risk, cells, r.confidence) for r, cells in zip(located, under, strict=True)]
        )
        risks = []
        for r, cells in zip(located, under, strict=True):
            p = evidence.posterior(r.risk, cells, r.confidence)
            if p < self.p.evidence.confirm:
                continue
            risks.append(replace(r, confidence=p))
            self.grid.mark_risk(cells, r.risk)
        self.detections_total += len(risks)
        return risks

    def stop(self, reason: str) -> None:
        if self.phase in ("takeoff", "mapping"):
            self._return(reason)

    # --- outputs ----------------------------------------------------------------------------

    def control(self, now: float, vs: VehicleState) -> Command:
        self._sense(vs)
        hold = Command((0.0, 0.0, 0.0), self.heading_deg, self.p.gimbal_pitch_deg)
        if self.phase == "landed":
            return hold
        if not vs.airborne and self.phase in ("mapping", "returning", "landing"):
            self.phase = "landed"
            return hold
        if self.phase == "takeoff":
            if not vs.airborne:
                return Command(
                    (0.0, 0.0, 0.0), self.heading_deg, self.p.gimbal_pitch_deg, "takeoff"
                )
            z = self.terrain.target_z(
                self.position, np.zeros(3), self.cruise_agl_m, self.mission.alt_max_m, 0.0
            )
            if self.position[2] >= z - 3.0:
                self.phase = "mapping"
            else:
                return self._fly(now, self.position[:2], z_override=z)
        if self.phase == "mapping":
            reason = self._failsafe(now, vs)
            if reason:
                self._return(reason)
            else:
                return self._map(now)
        if self.phase == "returning":
            assert self.home is not None
            if math.dist(self.position[:2], self.home) <= self.p.waypoint_tolerance_m:
                self.phase = "landing"
            else:
                return self._fly(now, self.home, final=True)
        return Command((0.0, 0.0, 0.0), self.heading_deg, self.p.gimbal_pitch_deg, "land")

    def wire_pose(self, vs: VehicleState) -> Pose:
        x, y = self.local.point_xy(vs.lat, vs.lng)
        z = self.home_ground_z + vs.z_m
        return Pose(
            vs.lat,
            vs.lng,
            max(0.0, z - self.grid.ground_at(x, y)),
            vs.heading_deg,
            self.p.gimbal_pitch_deg,
        )

    def state_message(self, vs: VehicleState) -> PeerState:
        goal = (
            None
            if self.goal is None or self.phase != "mapping"
            else (round(self.goal.x, 1), round(self.goal.y, 1))
        )
        p, v = self.position, self.velocity
        return PeerState(
            sent_at=now_iso(),
            phase=self.phase,
            position=(float(p[0]), float(p[1]), float(p[2])),
            velocity=(float(v[0]), float(v[1]), float(v[2])),
            goal=goal,
            battery_pct=vs.battery_pct,
        )

    def coverage_message(self) -> PeerCoverage | None:
        return self.grid.take_fresh()

    def coverage(self) -> float:
        return self.grid.coverage()

    # --- internals --------------------------------------------------------------------------

    def _sense(self, vs: VehicleState) -> None:
        x, y = self.local.point_xy(vs.lat, vs.lng)
        if self.home is None:
            self.home = np.array([x, y])
            self.home_ground_z = self.grid.ground_at(x, y)
        self.position = np.array([x, y, self.home_ground_z + vs.z_m])
        self.velocity = np.array(vs.velocity_enu)
        self.heading_deg = vs.heading_deg

    def _return(self, reason: str) -> None:
        self.phase, self.reason = "returning", reason
        self.goal, self.waypoints = None, []

    def _failsafe(self, now: float, vs: VehicleState) -> str:
        if self.coverage() >= self.p.coverage_target:
            return "mapped"
        if now - self.last_link > self.p.link_timeout_s:
            return "edge link lost"
        assert self.home is not None
        if self._battery_start is None:
            self._battery_start = (now, vs.battery_pct)
        t0, b0 = self._battery_start
        rate = (b0 - vs.battery_pct) / (now - t0) if now - t0 >= 20.0 else 0.0
        trip_s = (
            math.dist(self.position[:2], self.home) / self.p.cruise_speed_mps
            + self.position[2] / 1.5
        )
        if vs.battery_pct <= self.p.battery_reserve_pct + 1.3 * rate * trip_s:
            return f"battery {vs.battery_pct:.0f}%"
        return ""

    def _map(self, now: float) -> Command:
        if (
            self.waypoints
            and math.dist(self.position[:2], self.waypoints[0]) <= self.p.waypoint_tolerance_m
        ):
            self.waypoints.pop(0)
        if not self.waypoints or now >= self.replan_at:
            self._replan(now)
        if self.goal is None:
            if not self._open_tiles(now):
                self._return("mapped")
                return self._fly(
                    now, self.home if self.home is not None else self.position[:2], final=True
                )
            return self._fly(now, self.position[:2])
        return self._fly(now, self.waypoints[0], final=len(self.waypoints) == 1)

    def _open_tiles(self, now: float) -> list[GoalTile]:
        return [t for t in self.tiles.open_tiles() if self.unreachable.get(t.id, 0.0) <= now]

    def _replan(self, now: float) -> None:
        self.replan_at = now + self.p.replan_s
        tiles = self._open_tiles(now)
        me = Agent(self.drone_id, float(self.position[0]), float(self.position[1]), self._goal_xy())
        agents = [me]
        for peer in self.peers.active(now):
            if peer.state.phase in ("takeoff", "mapping"):
                at = peer.predict(now)
                agents.append(Agent(peer.drone_id, float(at[0]), float(at[1]), peer.state.goal))
        mine = assign(agents, tiles, self.tiles, keep_discount_m=self.tiles.tile_m)[self.drone_id]
        if mine is None:
            self.goal, self.waypoints = None, []
            return
        if self.goal is not None and mine.id == self.goal.id and self.waypoints:
            self.goal = mine
            return
        blocked = self.terrain.blocked(self.cruise_agl_m, self.mission.alt_max_m)
        path = plan(self.grid, blocked, self.position, np.array([mine.x, mine.y]))
        if path is None:
            self.unreachable[mine.id] = now + 60.0
            self.goal, self.waypoints = None, []
            self.replan_at = now
            return
        self.goal, self.waypoints = mine, path

    def _goal_xy(self) -> tuple[float, float] | None:
        return None if self.goal is None else (self.goal.x, self.goal.y)

    def _fly(
        self, now: float, target: FloatArray, final: bool = False, z_override: float | None = None
    ) -> Command:
        p = self.p
        to = np.asarray(target, dtype=np.float64)[:2] - self.position[:2]
        dist = float(np.hypot(*to))
        speed = p.cruise_speed_mps
        if final:
            speed = min(speed, math.sqrt(2 * 1.5 * dist))
        horiz = to / dist * speed if dist > 0.5 else np.zeros(2)
        want = np.array([horiz[0], horiz[1], 0.0])
        if z_override is None:
            z = self.terrain.target_z(
                self.position, want, self.cruise_agl_m, self.mission.alt_max_m, 4.0
            )
        else:
            z = z_override
        want[2] = float(np.clip(0.8 * (z - self.position[2]), -p.max_climb_mps, p.max_climb_mps))
        others = [
            (peer.predict(now), peer.velocity) for peer in self.peers.active(now) if peer.flying
        ]
        v = avoid(
            self.position, want, others, p.safe_separation_m, p.avoid_horizon_s, p.max_speed_mps
        )
        fence = self.grid.fly_radius_m
        if self.phase == "returning" and self.home is not None:
            fence = max(fence, float(np.hypot(*self.home)) + p.waypoint_tolerance_m)
        v = contain(self.position, v, fence, 2.0, p.max_speed_mps)
        heading = self.heading_deg
        if math.hypot(v[0], v[1]) > 1.0:
            heading = math.degrees(math.atan2(v[0], v[1])) % 360.0
        return Command((float(v[0]), float(v[1]), float(v[2])), heading, p.gimbal_pitch_deg)
