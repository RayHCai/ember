"""Keep the connectivity geofence and keep clear of other drones."""

from __future__ import annotations

import numpy as np

from ..geo import FloatArray

# Vertical gaps count double: two drones 10 m apart in altitude are as safe as 20 m apart sideways.
METRIC = np.array([1.0, 1.0, 2.0])


def contain(
    pos: FloatArray, vel: FloatArray, fly_radius_m: float, lookahead_s: float, max_speed: float
) -> FloatArray:
    """Velocity with any outward motion removed near the edge of the disc, and pulled back in
    when already outside it."""
    out = vel.copy()
    r = float(np.hypot(pos[0], pos[1]))
    if r < 1e-6:
        return out
    radial = np.array([pos[0] / r, pos[1] / r, 0.0])
    ahead = pos[:2] + vel[:2] * lookahead_s
    outward = float(np.dot(out, radial))
    if (np.hypot(*ahead) > fly_radius_m or r > fly_radius_m) and outward > 0:
        out -= radial * outward
    if r > fly_radius_m:
        out -= radial * min(max_speed, 0.5 * (r - fly_radius_m) + 1.0)
    return out


def avoid(
    pos: FloatArray,
    vel: FloatArray,
    others: list[tuple[FloatArray, FloatArray]],
    safe_m: float,
    horizon_s: float,
    max_speed: float,
) -> FloatArray:
    """Bend the desired velocity away from each drone it would pass closer than `safe_m` to
    within `horizon_s`, assuming the other keeps its velocity. Both drones of a pair push apart
    in opposite directions, so a head-on meeting resolves without negotiation."""
    out = vel.copy()
    for p, u in others:
        dp = (pos - p) * METRIC
        dv = (vel - u) * METRIC
        speed2 = float(np.dot(dv, dv))
        t = 0.0 if speed2 < 1e-9 else float(np.clip(-np.dot(dp, dv) / speed2, 0.0, horizon_s))
        closest = dp + dv * t
        d = float(np.linalg.norm(closest))
        if d >= safe_m:
            continue
        if d > 1e-3:
            away = closest / d
        else:
            side = np.array([-dv[1], dv[0], 0.0])
            n = float(np.linalg.norm(side))
            away = side / n if n > 1e-9 else np.array([1.0, 0.0, 0.0])
        out += away / METRIC * max_speed * (safe_m - d) / safe_m / (1.0 + t)
    speed = float(np.linalg.norm(out))
    if speed > max_speed:
        out *= max_speed / speed
    return out
