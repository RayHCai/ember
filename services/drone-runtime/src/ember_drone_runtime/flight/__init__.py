"""Flight controllers: what the runtime needs from an autopilot."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class VehicleState:
    lat: float
    lng: float
    # Height above the ground at the takeoff point (barometric/relative altitude on an autopilot).
    z_m: float
    velocity_enu: tuple[float, float, float]
    heading_deg: float
    battery_pct: float
    airborne: bool


class FlightController(Protocol):
    """Velocity-level control, which every common autopilot offers (PX4/ArduPilot offboard)."""

    async def state(self) -> VehicleState: ...

    async def takeoff(self, z_m: float) -> None: ...

    async def command(
        self, velocity_enu: tuple[float, float, float], heading_deg: float
    ) -> None: ...

    async def land(self) -> None: ...

    async def set_gimbal_pitch(self, pitch_deg: float) -> None: ...
