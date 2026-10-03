"""A procedural 3D world and a camera that ray-marches it: RGB, thermal and depth from any pose.

Trees and buildings stand on flat ground; fires burn in discs with a warm ring around them. Rays
through any pixel, from straight down to the horizon, hit the first surface along them, so
oblique views see the sides of tall things and depth behaves like a real LiDAR.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from ..camera import CameraSpec, Images, Pose, pixel_rays
from ..geo import FloatArray, LatLng, LocalFrame

GRASS = np.array([118, 138, 72], dtype=np.float64)
CANOPY = np.array([42, 84, 46], dtype=np.float64)
ROOF = np.array([150, 146, 140], dtype=np.float64)
SCORCHED = np.array([96, 78, 52], dtype=np.float64)
FLAME = np.array([255, 150, 40], dtype=np.float64)
SKY = np.array([170, 200, 235], dtype=np.float64)
GROUND_K, WARM_K, FIRE_K, SKY_K = 300.0, 360.0, 850.0, 235.0
MARCH_STEPS = 96
MAX_RANGE_M = 3000.0


@dataclass(frozen=True)
class Fire:
    x: float
    y: float
    radius_m: float
    warm_ring_m: float = 20.0


class SyntheticWorld:
    def __init__(
        self,
        origin: LatLng,
        half_extent_m: float,
        fires: list[Fire],
        seed: int = 0,
        res_m: float = 1.0,
    ) -> None:
        self.local = LocalFrame(origin)
        self.half = half_extent_m
        self.res = res_m
        n = int(2 * half_extent_m / res_m)
        rng = np.random.default_rng(seed)
        canopy = ndimage.gaussian_filter(rng.standard_normal((n, n)), 6.0 / res_m)
        trees = canopy > np.quantile(canopy, 0.7)
        crown = ndimage.gaussian_filter(rng.standard_normal((n, n)), 2.0 / res_m)
        height = np.where(trees, 12.0 + 40.0 * np.clip(crown - crown.min(), 0, None), 0.0)
        colour = np.broadcast_to(GRASS, (n, n, 3)).copy()
        colour[trees] = CANOPY
        roofs = np.zeros((n, n), dtype=bool)
        for _ in range(int(n * n * res_m**2 / 40000)):
            cx, cy = rng.integers(0, n, 2)
            w, h = (rng.integers(8, 20, 2) / res_m).astype(int)
            roofs[cy : cy + h, cx : cx + w] = True
        height[roofs] = 7.0
        colour[roofs] = ROOF
        centres = -half_extent_m + (np.arange(n) + 0.5) * res_m
        xx, yy = np.meshgrid(centres, centres)
        self.fire = np.zeros((n, n), dtype=bool)
        self.warm = np.zeros((n, n), dtype=bool)
        for f in fires:
            d = np.hypot(xx - f.x, yy - f.y)
            self.fire |= d <= f.radius_m
            self.warm |= (d > f.radius_m) & (d <= f.radius_m + f.warm_ring_m)
        self.warm &= ~self.fire
        flicker = rng.uniform(0.75, 1.0, (n, n, 1))
        colour[self.fire] = (FLAME * flicker)[self.fire]
        colour[self.warm] = SCORCHED
        self.height = height
        self.colour = colour.astype(np.uint8)
        self.fires = fires

    def _cells(
        self, x: FloatArray, y: FloatArray
    ) -> tuple[NDArray[np.intp], NDArray[np.intp], NDArray[np.bool_]]:
        n = self.height.shape[0]
        col = np.floor((x + self.half) / self.res).astype(np.intp)
        row = np.floor((y + self.half) / self.res).astype(np.intp)
        ok = (col >= 0) & (col < n) & (row >= 0) & (row < n)
        return np.clip(row, 0, n - 1), np.clip(col, 0, n - 1), ok

    def render(
        self, camera_xyz: FloatArray, heading_deg: float, pitch_deg: float, spec: CameraSpec
    ) -> Images:
        u = np.arange(spec.width_px) + 0.5
        v = np.arange(spec.height_px) + 0.5
        uu, vv = np.meshgrid(u, v)
        rays = pixel_rays(spec, heading_deg, pitch_deg, uu, vv).reshape(-1, 3)
        dz = rays[:, 2]
        z0 = camera_xyz[2]
        with np.errstate(divide="ignore"):
            s_ground = np.where(dz < -1e-9, z0 / -dz, np.inf)
        horiz = np.hypot(rays[:, 0], rays[:, 1])
        s_far = np.where(horiz > 1e-9, MAX_RANGE_M / np.maximum(horiz, 1e-9), np.inf)
        s_end = np.minimum(s_ground, s_far)
        top = float(self.height.max())
        with np.errstate(divide="ignore", invalid="ignore"):
            s_top = np.where(dz < -1e-9, np.maximum(0.0, (z0 - top) / -dz), 0.0)
        s_top = np.minimum(s_top, s_end)
        t = np.linspace(0.0, 1.0, MARCH_STEPS)
        span = np.where(np.isfinite(s_end), s_end - s_top, 0.0)
        s = s_top[:, None] + span[:, None] * t[None, :]
        px = camera_xyz[0] + rays[:, 0:1] * s
        py = camera_xyz[1] + rays[:, 1:2] * s
        pz = z0 + rays[:, 2:3] * s
        row, col, ok = self._cells(px, py)
        below = ok & (pz <= self.height[row, col]) & (s > 0)
        first = below.argmax(axis=1)
        hit_obj = below.any(axis=1)
        idx = np.arange(len(rays))
        depth = np.where(
            hit_obj,
            s[idx, first],
            np.where(np.isfinite(s_ground) & (s_ground <= s_far), s_ground, np.nan),
        )
        hx = camera_xyz[0] + rays[:, 0] * np.nan_to_num(depth)
        hy = camera_xyz[1] + rays[:, 1] * np.nan_to_num(depth)
        r, c, inside = self._cells(hx, hy)
        sky = ~np.isfinite(depth)
        rgb = np.where(inside[:, None], self.colour[r, c], GRASS)
        rgb = np.where(sky[:, None], SKY, rgb)
        thermal = np.full(len(rays), GROUND_K)
        thermal = np.where(inside & self.warm[r, c], WARM_K, thermal)
        thermal = np.where(inside & self.fire[r, c], FIRE_K, thermal)
        thermal = np.where(sky, SKY_K, thermal)
        shape = (spec.height_px, spec.width_px)
        return Images(
            rgb=np.clip(rgb, 0, 255).astype(np.uint8).reshape(*shape, 3),
            thermal_k=thermal.astype(np.float32).reshape(shape),
            depth_m=depth.astype(np.float32).reshape(shape),
            scenario_time=datetime.now(UTC),
        )


class SyntheticCamera:
    def __init__(self, world: SyntheticWorld, spec: CameraSpec) -> None:
        self.world = world
        self.spec = spec
        self.sensors = ["rgb", "thermal", "depth"]

    def render(self, pose: Pose) -> Images:
        x, y = self.world.local.point_xy(pose.lat, pose.lng)
        return self.world.render(
            np.array([x, y, pose.alt_m]), pose.heading_deg, pose.pitch_deg, self.spec
        )

    async def capture(self, pose: Pose) -> Images:
        return await asyncio.to_thread(self.render, pose)

    def scenario_clock(self) -> tuple[datetime | None, float]:
        return datetime.now(UTC), 1.0


def demo_world(origin: LatLng, radius_m: float, seed: int = 0) -> SyntheticWorld:
    """A world one connectivity radius wide with two fires off-centre."""
    r = radius_m
    fires = [
        Fire(0.35 * r, 0.25 * r, max(8.0, 0.06 * r)),
        Fire(-0.4 * r, -0.3 * r, max(6.0, 0.04 * r)),
    ]
    return SyntheticWorld(
        origin, math.ceil(r * 1.2), fires, seed=seed, res_m=1.0 if r <= 600 else 2.0
    )
