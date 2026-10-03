"""Pinhole camera geometry and the frames cameras produce.

Same conventions as `CameraSpec` and `DronePose` in packages/contracts/src/droneInfo.ts: heading 0
is north and 90 east, pitch -90 looks straight down with the image top towards the heading, 0 is the
horizon. Image rows grow downward, columns to the right. Roll is held level by the gimbal.

A pixel's ray is `forward + x * right + y * down` with `x, y` in focal units, so its dot product
with the optical axis is 1 and `camera + ray * depth` is the 3D point at z-depth `depth`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from numpy.typing import NDArray

from .geo import FloatArray


@dataclass(frozen=True)
class CameraSpec:
    width_px: int
    height_px: int
    hfov_deg: float

    @property
    def fx(self) -> float:
        return (self.width_px / 2) / math.tan(math.radians(self.hfov_deg) / 2)

    @property
    def vfov_deg(self) -> float:
        return math.degrees(2 * math.atan((self.height_px / 2) / self.fx))

    def footprint_m(self, height_m: float) -> tuple[float, float]:
        """Ground width and height covered looking straight down from `height_m`."""
        return (
            2 * height_m * math.tan(math.radians(self.hfov_deg) / 2),
            2 * height_m * math.tan(math.radians(self.vfov_deg) / 2),
        )


@dataclass(frozen=True)
class Pose:
    """Where the camera is, as reported on the wire. `alt_m` is above the ground directly below."""

    lat: float
    lng: float
    alt_m: float
    heading_deg: float
    pitch_deg: float


@dataclass
class Images:
    """What a camera returns. Thermal and depth cover the same field of view at their own size."""

    rgb: NDArray[np.uint8]
    thermal_k: NDArray[np.float32] | None = None
    depth_m: NDArray[np.float32] | None = None
    scenario_time: datetime | None = None


@dataclass
class Frame:
    frame_id: int
    captured_at: datetime
    pose: Pose
    camera: CameraSpec
    images: Images


def basis(heading_deg: float, pitch_deg: float) -> tuple[FloatArray, FloatArray, FloatArray]:
    """Forward, right and image-down unit vectors in east/north/up."""
    h, p = math.radians(heading_deg), math.radians(pitch_deg)
    fwd = np.array([math.sin(h) * math.cos(p), math.cos(h) * math.cos(p), math.sin(p)])
    right = np.array([math.cos(h), -math.sin(h), 0.0])
    down = np.cross(fwd, right)
    return fwd, right, down


def pixel_rays(
    spec: CameraSpec, heading_deg: float, pitch_deg: float, u: FloatArray, v: FloatArray
) -> FloatArray:
    """Rays (..., 3) through pixel coordinates (u, v), scaled to unit z-depth."""
    fwd, right, down = basis(heading_deg, pitch_deg)
    x = (u - spec.width_px / 2) / spec.fx
    y = (v - spec.height_px / 2) / spec.fx
    rays: FloatArray = fwd + x[..., None] * right + y[..., None] * down
    return rays


def sample_grid(spec: CameraSpec, cols: int) -> tuple[FloatArray, FloatArray]:
    """Pixel centres of an evenly spaced `cols`-wide sample of the image."""
    step = max(1.0, spec.width_px / cols)
    u = np.arange(step / 2, spec.width_px, step)
    v = np.arange(step / 2, spec.height_px, step)
    uu, vv = np.meshgrid(u, v)
    return uu.ravel(), vv.ravel()


def hit_plane(
    origin: FloatArray, rays: FloatArray, plane_z: float, max_range_m: float
) -> tuple[FloatArray, NDArray[np.bool_]]:
    """Where each ray meets the horizontal plane `z = plane_z`.

    Rays that miss the plane, or meet it further than `max_range_m` horizontally, are clipped to
    `max_range_m` along their horizontal direction and flagged False.
    """
    dz = rays[..., 2]
    height = origin[2] - plane_z
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(dz < -1e-9, -height / dz, np.inf)
    points = origin + rays * np.where(np.isfinite(s), s, 0.0)[..., None]
    points[..., 2] = plane_z
    offset = points[..., :2] - origin[:2]
    dist = np.hypot(offset[..., 0], offset[..., 1])
    hit = np.isfinite(s) & (dist <= max_range_m)
    horiz = np.hypot(rays[..., 0], rays[..., 1])
    with np.errstate(divide="ignore", invalid="ignore"):
        clip = rays[..., :2] / horiz[..., None] * max_range_m
    clip = np.where(horiz[..., None] > 1e-9, clip, 0.0)
    points[..., :2] = np.where(hit[..., None], points[..., :2], origin[:2] + clip)
    return points, hit


def sample_at(
    image: NDArray[np.float32], spec: CameraSpec, u: FloatArray, v: FloatArray
) -> FloatArray:
    """Nearest value of an image covering the camera's field of view at its own resolution."""
    h, w = image.shape[:2]
    cols = np.clip((u * w / spec.width_px).astype(int), 0, w - 1)
    rows = np.clip((v * h / spec.height_px).astype(int), 0, h - 1)
    out: FloatArray = image[rows, cols].astype(np.float64)
    return out
