"""Solar elevation (low-precision almanac, ~0.1 deg; plenty for lighting)."""

from __future__ import annotations

import math
from datetime import datetime, timezone


def sun_elevation_deg(lat: float, lon: float, t: datetime) -> float:
    t = t.astimezone(timezone.utc)
    jd = t.timestamp() / 86400.0 + 2440587.5
    n = jd - 2451545.0
    mean_lon = math.radians((280.460 + 0.9856474 * n) % 360)
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    ecl_lon = mean_lon + math.radians(1.915) * math.sin(g) + math.radians(0.020) * math.sin(2 * g)
    eps = math.radians(23.439 - 0.0000004 * n)
    ra = math.atan2(math.cos(eps) * math.sin(ecl_lon), math.cos(ecl_lon))
    dec = math.asin(math.sin(eps) * math.sin(ecl_lon))
    gmst_h = (18.697374558 + 24.06570982441908 * n) % 24
    ha = math.radians(gmst_h * 15 + lon) - ra
    la = math.radians(lat)
    return math.degrees(math.asin(math.sin(la) * math.sin(dec) + math.cos(la) * math.cos(dec) * math.cos(ha)))


def daylight(elev_deg: float) -> float:
    """Relative scene illumination: 1 in full sun, ~0.02 on a moonless night."""
    pts = [(-18, 0.02), (-12, 0.025), (-6, 0.12), (0, 0.5), (10, 0.95), (25, 1.0)]
    if elev_deg <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if elev_deg <= x1:
            return y0 + (y1 - y0) * (elev_deg - x0) / (x1 - x0)
    return 1.0
