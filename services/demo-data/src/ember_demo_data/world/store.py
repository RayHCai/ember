"""Builds the world assets once and caches them under data/derived/world/."""

from __future__ import annotations

import gzip
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from ..config import DERIVED_DIR, FIRE_WIND_FROM_DEG, REKINDLE, SCENARIO_END, SCENARIO_START
from .buildings import build_buildings
from .fire import build_fire_grid
from .frame import EXTENT, FRAME
from .imagery import CHAINS, MOSAIC_RES_M, build_mosaic, mosaic_size
from .layers import road_lines
from .vegetation import FIELDS, FORMS, build_vegetation

log = logging.getLogger(__name__)

# Bump when an algorithm changes so stale caches are rebuilt instead of served.
VERSION = 3
WORLD_DIR = DERIVED_DIR / "world"
ASSETS = (
    "vegetation.bin.gz",
    "buildings.json.gz",
    "roads.json.gz",
    "fire.bin.gz",
    "imagery_pre.jpg",
    "imagery_post.jpg",
)
_lock = threading.Lock()


def _dir() -> Path:
    return WORLD_DIR / f"v{VERSION}"


def _meta_path() -> Path:
    return _dir() / "meta.json"


def build(force: bool = False) -> dict[str, Any]:
    """Build every world asset (about a minute); a no-op when the cache is current."""
    with _lock:
        if not force and _meta_path().exists() and all((_dir() / a).exists() for a in ASSETS):
            cached: dict[str, Any] = json.loads(_meta_path().read_text())
            return cached
        started = time.monotonic()
        _dir().mkdir(parents=True, exist_ok=True)
        trees = build_vegetation()
        (_dir() / "vegetation.bin.gz").write_bytes(gzip.compress(trees.astype("<f4").tobytes(), 6))
        buildings = build_buildings()
        (_dir() / "buildings.json.gz").write_bytes(
            gzip.compress(json.dumps({"buildings": buildings}).encode(), 6)
        )
        roads = road_lines()
        (_dir() / "roads.json.gz").write_bytes(
            gzip.compress(json.dumps({"roads": roads}).encode(), 6)
        )
        fire_meta, fire = build_fire_grid()
        (_dir() / "fire.bin.gz").write_bytes(gzip.compress(fire, 6))
        for kind in CHAINS:
            (_dir() / f"imagery_{kind}.jpg").write_bytes(build_mosaic(kind))
        meta = {
            "vegetation_count": len(trees),
            "building_count": len(buildings),
            "road_count": len(roads),
            "fire": fire_meta,
        }
        _meta_path().write_text(json.dumps(meta))
        log.info("world assets built in %.0f s -> %s", time.monotonic() - started, _dir())
        return meta


def asset(name: str) -> bytes:
    if name not in ASSETS:
        raise KeyError(name)
    build()
    return (_dir() / name).read_bytes()


def manifest() -> dict[str, Any]:
    meta = build()
    width, height = mosaic_size()
    return {
        "version": VERSION,
        "frame": {
            "origin": {"lat": FRAME.lat0, "lon": FRAME.lon0},
            "metres_per_degree": {"lat": FRAME.m_lat, "lon": FRAME.m_lon},
            "axes": "x metres east and y metres north of the origin: x = (lon - lon0) * m_lon, "
            "y = (lat - lat0) * m_lat; ground is flat at z = 0",
        },
        "extent": EXTENT.as_dict(),
        "scenario": {
            "start": SCENARIO_START.isoformat(),
            "end": SCENARIO_END.isoformat(),
            "rekindle": REKINDLE.isoformat(),
            "timezone": "HST (UTC-10)",
            "wind_from_deg": FIRE_WIND_FROM_DEG,
            "note": "fire times are minutes after the rekindle; the morning fire has negative "
            "times",
        },
        "imagery": {
            "res_m": MOSAIC_RES_M,
            "width": width,
            "height": height,
            "extent": EXTENT.as_dict(),
            "rows": "first image row is the north edge",
            "layers": {
                kind: {
                    "url": f"/v1/world/imagery/{kind}.jpg",
                    "chain": list(chain),
                    "patch_url": f"/v1/world/imagery/{kind}/patch.jpg",
                }
                for kind, chain in CHAINS.items()
            },
        },
        "fire": {"url": "/v1/world/fire.bin", **meta["fire"]},
        "vegetation": {
            "url": "/v1/world/vegetation.bin",
            "count": meta["vegetation_count"],
            "fields": list(FIELDS),
            "forms": list(FORMS),
            "encoding": "little-endian float32, one row of len(fields) per tree",
            "survives": "1 if green canopy remains in post-fire imagery (or the fire never "
            "reaches it)",
        },
        "buildings": {"url": "/v1/world/buildings.json", "count": meta["building_count"]},
        "roads": {
            "url": "/v1/world/roads.json",
            "count": meta["road_count"],
            "encoding": "polylines of world-frame [x, y] points, each with its paved width_m",
        },
    }
