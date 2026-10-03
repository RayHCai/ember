"""Fold one camera frame into the mission grid."""

from __future__ import annotations

import numpy as np

from ..camera import Frame, hit_plane, pixel_rays, sample_at, sample_grid
from ..geo import FloatArray
from .grid import MissionGrid

# Rays sampled across the image width; at 80 m nadir that is one ray every ~2 m on the ground.
SAMPLE_COLS = 64


def integrate_frame(
    grid: MissionGrid,
    frame: Frame,
    camera_xyz: FloatArray,
    ground_z: float,
    max_range_m: float,
) -> int:
    """Mark what the frame saw. With depth, every sample is a 3D point that also feeds the height
    map; without depth, rays are cast onto the ground estimate. Returns newly observed cells."""
    u, v = sample_grid(frame.camera, SAMPLE_COLS)
    rays = pixel_rays(frame.camera, frame.pose.heading_deg, frame.pose.pitch_deg, u, v)
    depth = frame.images.depth_m
    if depth is not None:
        d = sample_at(depth, frame.camera, u, v)
        ok = np.isfinite(d) & (d > 0)
        pts = camera_xyz + rays[ok] * d[ok, None]
        near = np.hypot(pts[:, 0] - camera_xyz[0], pts[:, 1] - camera_xyz[1]) <= max_range_m
        pts = pts[near]
        return grid.observe(pts[:, 0], pts[:, 1], pts[:, 2])
    pts, hit = hit_plane(camera_xyz, rays, ground_z, max_range_m)
    return grid.observe(pts[hit, 0], pts[hit, 1], None)
