"""A point-mass multicopter: velocity commands with acceleration limits and a draining battery."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from ..geo import FloatArray, LatLng, LocalFrame
from . import VehicleState


@dataclass
class Kinematics:
    """Synchronous core of the simulator; `step` advances it by `dt` seconds."""

    home: LatLng
    max_speed_mps: float = 12.0
    max_accel_mps2: float = 4.0
    max_climb_mps: float = 4.0
    endurance_s: float = 1500.0
    position: FloatArray = field(default_factory=lambda: np.zeros(3))
    velocity: FloatArray = field(default_factory=lambda: np.zeros(3))
    heading_deg: float = 0.0
    battery_pct: float = 100.0
    airborne: bool = False
    landing: bool = False
    gimbal_pitch_deg: float = -90.0
    _target_vel: FloatArray = field(default_factory=lambda: np.zeros(3))
    _target_heading: float = 0.0

    def __post_init__(self) -> None:
        self.frame = LocalFrame(self.home)

    def takeoff(self) -> None:
        if self.battery_pct > 0:
            self.airborne, self.landing = True, False

    def command(self, velocity: FloatArray, heading_deg: float) -> None:
        v = np.array(velocity, dtype=np.float64)
        horiz = math.hypot(v[0], v[1])
        if horiz > self.max_speed_mps:
            v[:2] *= self.max_speed_mps / horiz
        v[2] = float(np.clip(v[2], -self.max_climb_mps, self.max_climb_mps))
        self._target_vel = v
        self._target_heading = heading_deg % 360.0

    def land(self) -> None:
        self.landing = True

    def step(self, dt: float) -> None:
        if not self.airborne:
            self.velocity[:] = 0.0
            return
        target = (
            np.array([0.0, 0.0, -1.5])
            if self.landing or self.battery_pct <= 0
            else self._target_vel
        )
        dv = target - self.velocity
        n = float(np.linalg.norm(dv))
        limit = self.max_accel_mps2 * dt
        self.velocity += dv if n <= limit else dv * (limit / n)
        self.position += self.velocity * dt
        turn = (self._target_heading - self.heading_deg + 180.0) % 360.0 - 180.0
        self.heading_deg = (self.heading_deg + float(np.clip(turn, -90 * dt, 90 * dt))) % 360.0
        load = 1.0 + 0.3 * float(np.linalg.norm(self.velocity)) / self.max_speed_mps
        self.battery_pct = max(0.0, self.battery_pct - 100.0 * dt * load / self.endurance_s)
        if self.position[2] <= 0.0:
            self.position[2] = 0.0
            if self.landing or self.velocity[2] < 0:
                self.airborne, self.landing = False, False
                self.velocity[:] = 0.0

    def state(self) -> VehicleState:
        lat, lng = self.frame.to_latlng(self.position[0], self.position[1])
        return VehicleState(
            lat=float(lat),
            lng=float(lng),
            z_m=float(self.position[2]),
            velocity_enu=(
                float(self.velocity[0]),
                float(self.velocity[1]),
                float(self.velocity[2]),
            ),
            heading_deg=self.heading_deg,
            battery_pct=self.battery_pct,
            airborne=self.airborne,
        )


class SimulatedFlight:
    """`FlightController` over `Kinematics`, on a clock that may run faster than real time."""

    def __init__(self, kinematics: Kinematics, clock: Callable[[], float]) -> None:
        self.k = kinematics
        self.clock = clock
        self._last = clock()

    def _advance(self) -> None:
        now = self.clock()
        dt = now - self._last
        self._last = now
        while dt > 0:
            step = min(dt, 0.05)
            self.k.step(step)
            dt -= step

    async def state(self) -> VehicleState:
        self._advance()
        return self.k.state()

    async def takeoff(self, z_m: float) -> None:
        self._advance()
        self.k.takeoff()
        self.k.command(np.array([0.0, 0.0, self.k.max_climb_mps]), self.k.heading_deg)

    async def command(self, velocity_enu: tuple[float, float, float], heading_deg: float) -> None:
        self._advance()
        self.k.command(np.array(velocity_enu), heading_deg)

    async def land(self) -> None:
        self._advance()
        self.k.land()

    async def set_gimbal_pitch(self, pitch_deg: float) -> None:
        self.k.gimbal_pitch_deg = pitch_deg
