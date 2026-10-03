"""Cameras: anything that returns images for the pose the drone is at."""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from ..camera import CameraSpec, Images, Pose


class CameraError(RuntimeError):
    """A capture failed; the runtime logs it and tries the next frame."""


class Camera(Protocol):
    spec: CameraSpec
    # Subset of "rgb", "thermal", "depth" this camera fills in.
    sensors: list[str]

    async def capture(self, pose: Pose) -> Images:
        """Images at `pose`. Hardware ignores the pose; simulated cameras render from it."""
        ...

    def scenario_clock(self) -> tuple[datetime | None, float]:
        """Time the images follow and its speed against the wall clock (hardware: now, 1)."""
        ...
