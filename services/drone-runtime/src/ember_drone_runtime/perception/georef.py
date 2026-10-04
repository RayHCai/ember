"""Project image regions onto the world: a region's outline (or its box) becomes a ground outline
in the mission frame."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..camera import Frame, hit_plane, pixel_rays, sample_at
from ..geo import FloatArray, LatLng, LocalFrame, inside_polygon, polygon_area, polygon_centroid
from .detector import Box, Detection2D, Outline, Risk


@dataclass(frozen=True)
class RiskDetection:
    id: str
    risk: Risk
    confidence: float
    bbox_px: Box
    ground: tuple[LatLng, ...]
    center: LatLng
    area_m2: float
    peak_temp_k: float | None
    # Ground outline in the mission frame, metres east/north.
    outline_xy: FloatArray


def surface_points(
    frame: Frame, camera_xyz: FloatArray, box: Box, outline: Outline | None = None
) -> FloatArray | None:
    """3D points the depth image sees across the box, inside the outline when there is one; None
    without depth."""
    depth = frame.images.depth_m
    if depth is None:
        return None
    u = np.linspace(box[0], box[2], 9)[1:-1]
    v = np.linspace(box[1], box[3], 9)[1:-1]
    uu, vv = (a.ravel() for a in np.meshgrid(u, v))
    if outline is not None:
        inside = inside_polygon(uu, vv, np.array(outline))
        if inside.any():
            uu, vv = uu[inside], vv[inside]
    d = sample_at(depth, frame.camera, uu, vv)
    ok = np.isfinite(d) & (d > 0)
    if not ok.any():
        return None
    rays = pixel_rays(frame.camera, frame.pose.heading_deg, frame.pose.pitch_deg, uu[ok], vv[ok])
    pts: FloatArray = camera_xyz + rays * d[ok, None]
    return pts


def georeference(
    det: Detection2D,
    det_id: str,
    frame: Frame,
    camera_xyz: FloatArray,
    ground_z: float,
    local: LocalFrame,
    max_range_m: float,
) -> RiskDetection:
    """The region's outline (or box) on the surface it shows (depth) or on the ground estimate (no
    depth).

    With depth the centre is the median of the region's own 3D points, so something tall near the
    edge of a wide frame is not pushed outward by parallax.
    """
    x0, y0, x1, y1 = det.bbox
    surface = surface_points(frame, camera_xyz, det.bbox, det.outline)
    plane = ground_z
    if surface is not None:
        plane = min(float(np.median(surface[:, 2])), float(camera_xyz[2]) - 0.5)
    pose = frame.pose
    if det.outline is not None:
        ring = np.array(det.outline)
        us, vs = ring[:, 0], ring[:, 1]
    else:
        us, vs = np.array([x0, x1, x1, x0]), np.array([y0, y0, y1, y1])
    rays = pixel_rays(frame.camera, pose.heading_deg, pose.pitch_deg, us, vs)
    pts, hit = hit_plane(camera_xyz, rays, plane, max_range_m)
    if det.outline is None and not hit.all():
        t = np.linspace(0, 1, 8, endpoint=False)
        us = np.concatenate(
            [x0 + t * (x1 - x0), np.full(8, x1), x1 - t * (x1 - x0), np.full(8, x0)]
        )
        vs = np.concatenate(
            [np.full(8, y0), y0 + t * (y1 - y0), np.full(8, y1), y1 - t * (y1 - y0)]
        )
        rays = pixel_rays(frame.camera, pose.heading_deg, pose.pitch_deg, us, vs)
        pts, _ = hit_plane(camera_xyz, rays, plane, max_range_m)
    outline = pts[:, :2]
    if surface is not None:
        centre = np.median(surface, axis=0)[:2]
    elif det.outline is not None:
        centre = polygon_centroid(outline)
    else:
        centre_ray = pixel_rays(
            frame.camera,
            pose.heading_deg,
            pose.pitch_deg,
            np.array([(x0 + x1) / 2]),
            np.array([(y0 + y1) / 2]),
        )
        centre = hit_plane(camera_xyz, centre_ray, plane, max_range_m)[0][0, :2]
    lat, lng = local.to_latlng(outline[:, 0], outline[:, 1])
    return RiskDetection(
        id=det_id,
        risk=det.risk,
        confidence=det.confidence,
        bbox_px=det.bbox,
        ground=tuple(LatLng(float(a), float(b)) for a, b in zip(lat, lng, strict=True)),
        center=local.latlng(float(centre[0]), float(centre[1])),
        area_m2=polygon_area(outline),
        peak_temp_k=det.peak_temp_k,
        outline_xy=outline,
    )
