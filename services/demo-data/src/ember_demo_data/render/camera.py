"""Pinhole camera on a drone, ray-cast onto flat ground at the drone's ground level.

Conventions:
    alt_m        height above the ground directly below the drone
    heading_deg  compass direction the camera faces (0 = north, 90 = east)
    pitch_deg    camera tilt: -90 looks straight down (image top = heading), 0 = horizon
Image rows grow downward, columns grow to the right.

Ground points are converted to lon/lat with an exact azimuthal-equidistant projection
centred on the drone, so a pixel showing a point 250 m north-east of the drone maps to the
point that is really 250 m north-east.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..geo import FittedTransform, LocalFrame

MAX_RANGE_M = 4000.0


@dataclass(frozen=True)
class Pose:
    lat: float
    lon: float
    alt_m: float = 120.0
    heading_deg: float = 0.0
    pitch_deg: float = -90.0

    def validated(self) -> Pose:
        if not (1.0 <= self.alt_m <= 3000.0):
            raise ValueError(f"alt_m must be between 1 and 3000 m, got {self.alt_m}")
        if not (-90.0 <= self.pitch_deg <= 30.0):
            raise ValueError(f"pitch_deg must be between -90 (nadir) and 30, got {self.pitch_deg}")
        return Pose(self.lat, self.lon, self.alt_m, self.heading_deg % 360.0, self.pitch_deg)


@dataclass(frozen=True)
class Camera:
    width: int = 640
    height: int = 480
    hfov_deg: float = 84.0

    @property
    def fx(self) -> float:
        return (self.width / 2) / math.tan(math.radians(self.hfov_deg) / 2)

    @property
    def vfov_deg(self) -> float:
        return math.degrees(2 * math.atan((self.height / 2) / self.fx))

    def validated(self) -> Camera:
        if not (16 <= self.width <= 2048 and 16 <= self.height <= 2048):
            raise ValueError("image width/height must be between 16 and 2048")
        if not (5.0 <= self.hfov_deg <= 150.0):
            raise ValueError("hfov_deg must be between 5 and 150")
        return self


def basis(pose: Pose) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Forward, right and image-down unit vectors in local east/north/up."""
    h, p = math.radians(pose.heading_deg), math.radians(pose.pitch_deg)
    fwd = np.array([math.sin(h) * math.cos(p), math.cos(h) * math.cos(p), math.sin(p)])
    right = np.array([math.cos(h), -math.sin(h), 0.0])
    down = np.cross(fwd, right)
    return fwd, right, down


@dataclass
class RayHits:
    east: np.ndarray  # metres east of the drone (NaN where the ray misses the ground)
    north: np.ndarray
    lon: np.ndarray
    lat: np.ndarray
    utm_e: np.ndarray  # UTM 4N easting/northing of each ground point (analysis grid CRS)
    utm_n: np.ndarray
    ground: np.ndarray  # bool
    range_m: np.ndarray  # slant range
    path_factor: np.ndarray  # 1/cos(zenith) of the view ray, for atmospheric path length
    ray_elev_deg: np.ndarray  # elevation angle of each ray (negative looks down)
    gsd_m: float  # median ground sample distance of ground pixels


def cast(pose: Pose, cam: Camera, sample: tuple[np.ndarray, np.ndarray] | None = None) -> RayHits:
    """Intersect every pixel's ray (or the given (u, v) pixel coordinates) with the ground."""
    fwd, right, down = basis(pose)
    if sample is None:
        u = np.arange(cam.width) + 0.5
        v = np.arange(cam.height) + 0.5
        U, V = np.meshgrid(u, v)
    else:
        U, V = sample
    x = (U - cam.width / 2) / cam.fx
    y = (V - cam.height / 2) / cam.fx
    rays = fwd + x[..., None] * right + y[..., None] * down
    dz = rays[..., 2]
    norm = np.linalg.norm(rays, axis=-1)
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(dz < -1e-9, -pose.alt_m / dz, np.nan)
        east, north = s * rays[..., 0], s * rays[..., 1]
        ground = np.isfinite(s) & (np.hypot(east, north) <= MAX_RANGE_M)
        east = np.where(ground, east, np.nan)
        north = np.where(ground, north, np.nan)
        rng = np.where(ground, s * norm, np.nan)
        path = np.where(ground, np.minimum(norm / -dz, 6.0), np.nan)
    elev = np.degrees(np.arcsin(np.clip(dz / norm, -1, 1)))
    lon = np.full(east.shape, np.nan)
    lat = np.full(east.shape, np.nan)
    utm_e = np.full(east.shape, np.nan)
    utm_n = np.full(east.shape, np.nan)
    if ground.any():
        frame = LocalFrame(pose.lon, pose.lat)
        ge, gn = east[ground], north[ground]
        ext = (float(ge.min()), float(ge.max())), (float(gn.min()), float(gn.max()))
        # Exact projection on control points, verified cubic fit everywhere else (<1 mm).
        to_ll = FittedTransform(frame.to_lonlat, *ext, tol=1e-8)
        to_utm = FittedTransform(frame.to_utm, *ext, tol=1e-3)
        lon[ground], lat[ground] = to_ll(ge, gn)
        utm_e[ground], utm_n[ground] = to_utm(ge, gn)
    gsd = float("nan")
    if U.ndim == 2 and ground.any():
        de = np.hypot(np.gradient(east, axis=1), np.gradient(north, axis=1))
        gsd = float(np.nanmedian(de[ground]))
    return RayHits(east, north, lon, lat, utm_e, utm_n, ground, rng, path, elev, gsd)


def footprint(pose: Pose, cam: Camera, edge_samples: int = 8) -> list[tuple[float, float]]:
    """Visible ground outline as (lon, lat) points, clockwise from the image top-left.

    Edge pixels whose rays miss the ground (looking above the horizon) are clipped at
    MAX_RANGE_M along their horizontal direction.
    """
    W, H = cam.width, cam.height
    t = np.linspace(0, 1, edge_samples, endpoint=False)
    us = np.concatenate([t * W, np.full_like(t, W), W - t * W, np.zeros_like(t)])
    vs = np.concatenate([np.zeros_like(t), t * H, np.full_like(t, H), H - t * H])
    fwd, right, down = basis(pose)
    pts = []
    frame = LocalFrame(pose.lon, pose.lat)
    for u, v in zip(us, vs, strict=True):
        ray = fwd + ((u - W / 2) / cam.fx) * right + ((v - H / 2) / cam.fx) * down
        horiz = math.hypot(ray[0], ray[1])
        if ray[2] < -1e-9:
            s = -pose.alt_m / ray[2]
            e, n = s * ray[0], s * ray[1]
            d = math.hypot(e, n)
            if d > MAX_RANGE_M:
                e, n = e * MAX_RANGE_M / d, n * MAX_RANGE_M / d
        elif horiz > 1e-9:
            e, n = ray[0] / horiz * MAX_RANGE_M, ray[1] / horiz * MAX_RANGE_M
        else:
            continue
        lo, la = frame.to_lonlat(e, n)
        pts.append((float(lo), float(la)))
    return pts


def ground_point(pose: Pose, u: float, v: float, cam: Camera) -> tuple[float, float] | None:
    """lon/lat seen at pixel (u, v), or None if that pixel shows sky."""
    hits = cast(pose, cam, (np.array([u]), np.array([v])))
    if not hits.ground[0]:
        return None
    return float(hits.lon[0]), float(hits.lat[0])
