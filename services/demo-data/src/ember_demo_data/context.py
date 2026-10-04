"""Real context feeds a drone or planner could have had at a given moment: weather, satellite
fire detections, and the pre-fire building inventory.

Nothing here returns information from after the requested time: satellite detections are
filtered to scans that had completed by then, and structure states are only exposed
through the explicit `truth` flag.
"""

from __future__ import annotations

import csv
import json
import math
import threading
from bisect import bisect_right
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import numpy as np
from shapely import STRtree
from shapely.geometry import Point, Polygon

from .config import DERIVED_DIR, FIRE_WIND_FROM_DEG, HST, RAW_DIR, WEATHER_STATION, hst
from .geo import geodesic_m
from .model.grid import GRID
from .model.state import AT_RISK, minutes_since_rekindle, scenario

RED_FLAG = (hst(2023, 8, 6, 3, 33), hst(2023, 8, 9, 18, 0))
RED_FLAG_NOTE = (
    "NWS Honolulu Red Flag Warning for leeward areas, strong gusty easterly winds and low humidity "
    "(statements in the FSRI timeline from Aug 6 03:33 to Aug 9 03:18, 'until this evening')"
)
KT_TO_MPS = 0.514444


def _f(v: str) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@lru_cache(maxsize=1)
def _weather() -> tuple[list[datetime], list[dict[str, Any]]]:
    rows = []
    with (RAW_DIR / f"weather_{WEATHER_STATION['id']}.csv").open() as f:
        for r in csv.DictReader(f):
            t = datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=UTC)
            rows.append((t, r))
    rows.sort(key=lambda x: x[0])
    return [t for t, _ in rows], [r for _, r in rows]


def weather_at(t: datetime) -> dict[str, Any]:
    times, rows = _weather()
    i = bisect_right(times, t) - 1
    # 5-minute ASOS records often omit temperature/humidity; take each field from the most
    # recent report (within 90 min) that has it.
    latest: dict[str, tuple[datetime, float]] = {}
    while i >= 0 and t - times[i] <= timedelta(minutes=90):
        for key in ("tmpf", "relh", "drct", "sknt", "gust", "vsby"):
            v = _f(rows[i][key])
            if key not in latest and v is not None:
                latest[key] = (times[i], v)
        i -= 1
    obs: dict[str, Any] | None = None
    if "sknt" in latest:

        def val(key: str, fn: Callable[[float], float]) -> float | None:
            return round(fn(latest[key][1]), 1) if key in latest else None

        obs = {
            "observed_at": latest["sknt"][0].astimezone(HST).isoformat(),
            "temperature_c": val("tmpf", lambda f: (f - 32) * 5 / 9),
            "relative_humidity_pct": val("relh", lambda v: v),
            "wind_from_deg": val("drct", lambda v: v),
            "wind_speed_mps": val("sknt", lambda v: v * KT_TO_MPS),
            "wind_gust_mps": val("gust", lambda v: v * KT_TO_MPS)
            if "gust" in latest and t - latest["gust"][0] <= timedelta(minutes=20)
            else None,
            "visibility_km": val("vsby", lambda v: v * 1.609),
            "field_times": {k: v[0].astimezone(HST).isoformat() for k, v in latest.items()},
        }
    return {
        "station": {k: WEATHER_STATION[k] for k in ("id", "name", "lat", "lon", "note")},
        "observation": obs,
        "fire_wind_from_deg": FIRE_WIND_FROM_DEG,
        "fire_wind_note": "Direction the synthetic fire spreads with: downslope "
        "east-north-easterly winds "
        "over the West Maui Mountains (spread toward the ocean in the FSRI reports).",
        "red_flag_warning": RED_FLAG[0] <= t <= RED_FLAG[1],
        "red_flag_note": RED_FLAG_NOTE,
    }


# --- Satellite detections --------------------------------------------------------------------


@lru_cache(maxsize=1)
def _goes() -> tuple[list[tuple[datetime, int, float]], dict[datetime, list[dict[str, Any]]]]:
    scans: list[tuple[datetime, int, float]] = []
    with (RAW_DIR / "goes18_scans.csv").open() as f:
        for r in csv.DictReader(f):
            scans.append(
                (
                    datetime.fromisoformat(r["scan_start_utc"]),
                    int(r["fire_pixels"]),
                    float(r["frp_mw"]),
                )
            )
    pixels: dict[datetime, list[dict[str, Any]]] = {}
    with (RAW_DIR / "goes18_fire_pixels.csv").open() as f:
        for r in csv.DictReader(f):
            pixels.setdefault(datetime.fromisoformat(r["scan_start_utc"]), []).append(r)
    scans.sort()
    return scans, pixels


@lru_cache(maxsize=1)
def _polar() -> list[dict[str, Any]]:
    out = []
    with (RAW_DIR / "firms_west_maui_aug2023.csv").open() as f:
        for r in csv.DictReader(f):
            hhmm = r["acq_time"].zfill(4)
            t = datetime.strptime(f"{r['acq_date']} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=UTC)
            out.append({"t": t, **r})
    out.sort(key=lambda d: d["t"])
    return out


GOES_SCAN_LATENCY = timedelta(
    minutes=5
)  # a scan's product is available a few minutes after its start


def satellite_at(
    t: datetime, lat: float, lon: float, radius_km: float = 15.0, polar_window_h: float = 12.0
) -> dict[str, Any]:
    scans, pixels = _goes()
    latest = None
    for s in reversed(scans):
        if s[0] + GOES_SCAN_LATENCY <= t:
            latest = s
            break
    goes = None
    if latest is not None:
        pts = []
        for p in pixels.get(latest[0], []):
            d = float(geodesic_m(lon, lat, float(p["lon"]), float(p["lat"]))) / 1000
            if d <= radius_km:
                pts.append(
                    {
                        "lat": float(p["lat"]),
                        "lon": float(p["lon"]),
                        "frp_mw": _f(p["frp_mw"]),
                        "temp_k": _f(p["temp_k"]),
                        "mask_code": int(p["mask"]),
                        "distance_km": round(d, 2),
                    }
                )
        goes = {
            "scan_start": latest[0].astimezone(HST).isoformat(),
            "pixel_size_km": 2.0,
            "detections": pts,
            "note": "GOES-18 ABI fire/hot spot product (real). Pixels are ~2 km; positions are "
            "pixel centres.",
        }
    polar = []
    lo = t - timedelta(hours=polar_window_h)
    for rec in _polar():
        if lo <= rec["t"] <= t:
            dist = (
                float(geodesic_m(lon, lat, float(rec["longitude"]), float(rec["latitude"]))) / 1000
            )
            if dist <= radius_km:
                polar.append(
                    {
                        "time": rec["t"].astimezone(HST).isoformat(),
                        "product": rec["product"],
                        "lat": float(rec["latitude"]),
                        "lon": float(rec["longitude"]),
                        "frp_mw": _f(rec["frp"]),
                        "confidence": rec["confidence"],
                        "distance_km": round(dist, 2),
                    }
                )
    return {
        "goes18": goes,
        "polar_orbiting": polar,
        "polar_note": "NASA FIRMS VIIRS (375 m) and MODIS (1 km) detections from the last "
        f"{polar_window_h:g} h (real).",
    }


# --- Structures ------------------------------------------------------------------------------

STRUCTURE_FLAME_MIN = 110.0
STRUCTURE_SMOULDER_MIN = 1080.0


class Structures:
    def __init__(self) -> None:
        data = json.loads((DERIVED_DIR / "structures.geojson").read_text())
        self.props = [f["properties"] for f in data["features"]]
        self.points = [Point(p["lon"], p["lat"]) for p in self.props]
        self.tree = STRtree(self.points)

    def state(self, i: int, t: datetime) -> str:
        p = self.props[i]
        m = minutes_since_rekindle(t)
        ign = p["ignition_min"]
        if p["fate"] == "destroyed" and ign is not None:
            if m >= ign + STRUCTURE_FLAME_MIN + STRUCTURE_SMOULDER_MIN:
                return "destroyed"
            if m >= ign + STRUCTURE_FLAME_MIN:
                return "smouldering"
            if m >= ign:
                return "burning"
        fields = scenario().fields(t)
        r, c = GRID.lonlat_to_rc(p["lon"], p["lat"])
        row, col = round(float(r)), round(float(c))
        if 0 <= row < GRID.height and 0 <= col < GRID.width and fields.classes[row, col] == AT_RISK:
            return "at_risk"
        return "intact"

    def within(
        self, polygon: Polygon, t: datetime, truth: bool, limit: int = 300
    ) -> dict[str, Any]:
        idx = self.tree.query(polygon, predicate="contains")
        idx = sorted(int(i) for i in idx)
        items = []
        for i in idx[:limit]:
            p = self.props[i]
            item = {"id": p["id"], "lat": p["lat"], "lon": p["lon"], "area_m2": p["area_m2"]}
            if p.get("name"):
                item["name"] = p["name"]
            if truth:
                item["state"] = self.state(i, t)
            items.append(item)
        return {
            "count": len(idx),
            "items": items,
            "truncated": len(idx) > limit,
            "note": "Pre-fire building inventory (OpenStreetMap as of 2023-08-07 + Microsoft "
            "footprints).",
        }

    def near(
        self, lat: float, lon: float, radius_m: float, t: datetime, truth: bool, limit: int = 500
    ) -> dict[str, Any]:
        dlat = radius_m / 111_320.0
        dlon = radius_m / (111_320.0 * math.cos(math.radians(lat)))
        box = Polygon(
            [
                (lon - dlon, lat - dlat),
                (lon + dlon, lat - dlat),
                (lon + dlon, lat + dlat),
                (lon - dlon, lat + dlat),
            ]
        )
        idx = [int(i) for i in self.tree.query(box, predicate="contains")]
        lons = np.array([self.props[i]["lon"] for i in idx])
        lats = np.array([self.props[i]["lat"] for i in idx])
        d = geodesic_m(lon, lat, lons, lats) if idx else np.array([])
        keep = [(float(dd), i) for dd, i in zip(d, idx, strict=True) if dd <= radius_m]
        keep.sort()
        items = []
        for dist, i in keep[:limit]:
            p = self.props[i]
            item = {
                "id": p["id"],
                "lat": p["lat"],
                "lon": p["lon"],
                "area_m2": p["area_m2"],
                "distance_m": round(dist, 1),
            }
            if truth:
                item["state"] = self.state(i, t)
            items.append(item)
        return {"count": len(keep), "items": items, "truncated": len(keep) > limit}


_structures: Structures | None = None
_lock = threading.Lock()


def structures() -> Structures:
    global _structures
    with _lock:
        if _structures is None:
            _structures = Structures()
        return _structures
