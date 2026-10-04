"""Training frames from Demo Data (services/demo-data) with its per-pixel truth labels.

Talks to Demo Data only over HTTP: `/v1/truth/fire` to find where the fire is at a time, then
`/v1/observation?truth=true` for an RGB frame, its thermal frame and its label image. Most shots
look at the active front from varied heights and angles; the rest wander the burn area for burned
ground and background.

Demo Data's labels are the fire model's 10 m cell states, wider than the flames it draws. Flame is
therefore the on-fire pixels that are also hot in thermal (Demo Data writes 520 K + 680 K x flame
opacity where it draws flame); on-fire ground with no drawn flame reads as burned. At night burned
ground is invisible, so night frames label flame only.

Its smoke plumes are drawn but unlabelled, so they would be taught as background; keep this source
to at most 30 % of the training set (assembly's cap).
"""

from __future__ import annotations

import base64
import io
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from numpy.typing import NDArray
from PIL import Image

from .classes import BURNED, FLAME
from .labels import Instance, mask_instances
from .sources import SourceInfo, Stager

HST = timezone(timedelta(hours=-10))
# The rekindle that burned Lahaina, to an hour after sunset (19:05): later frames are mostly black.
FIRE_START = datetime(2023, 8, 8, 15, 0, tzinfo=HST)
FIRE_END = datetime(2023, 8, 8, 20, 0, tzinfo=HST)
# Demo Data's coverage box, and the burn inside it.
COVERAGE = (20.838, -156.695, 20.915, -156.640)
BURN = (20.862, -156.690, 20.897, -156.655)
M_PER_DEG_LAT = 111_320.0
# Demo Data label ids.
ON_FIRE, SMOULDERING, BURNED_ID, SKY = 2, 3, 4, 255
# Thermal at a drawn flame opacity of about 0.2, where it starts to show in RGB.
FLAME_K = 600.0
LICENSE = (
    "Synthetic render by Ember Demo Data over Maxar CC BY-NC 4.0 and Esri Wayback imagery: "
    "non-commercial"
)


@dataclass(frozen=True)
class Shot:
    lat: float
    lon: float
    alt_m: float
    heading_deg: float
    pitch_deg: float
    t: datetime


def aim(
    target: tuple[float, float], alt_m: float, heading_deg: float, pitch_deg: float
) -> tuple[float, float]:
    """Where a drone must hover so its camera centre looks at `target` (lat, lon) on flat ground."""
    back = alt_m / math.tan(math.radians(-pitch_deg)) if pitch_deg > -89.9 else 0.0
    h = math.radians(heading_deg)
    lat = target[0] - back * math.cos(h) / M_PER_DEG_LAT
    lon = target[1] - back * math.sin(h) / (M_PER_DEG_LAT * math.cos(math.radians(target[0])))
    return lat, lon


def plan_shot(rng: random.Random, t: datetime, fire: list[tuple[float, float]]) -> Shot:
    """One camera pose at time `t`; `fire` is (lat, lon) points on the active front."""
    if fire and rng.random() < 0.7:
        lat, lon = rng.choice(fire)
        lat += rng.uniform(-60, 60) / M_PER_DEG_LAT
        lon += rng.uniform(-60, 60) / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    else:
        lat, lon = rng.uniform(BURN[0], BURN[2]), rng.uniform(BURN[1], BURN[3])
    alt = rng.uniform(40.0, 200.0)
    heading = rng.uniform(0.0, 360.0)
    pitch = rng.uniform(-90.0, -70.0) if rng.random() < 0.6 else rng.uniform(-65.0, -25.0)
    lat, lon = aim((lat, lon), alt, heading, pitch)
    lat = min(max(lat, COVERAGE[0] + 1e-4), COVERAGE[2] - 1e-4)
    lon = min(max(lon, COVERAGE[1] + 1e-4), COVERAGE[3] - 1e-4)
    return Shot(lat, lon, alt, heading, pitch, t)


def fire_points(truth: dict[str, Any]) -> list[tuple[float, float]]:
    """(lat, lon) vertices of the on-fire polygons in a `/v1/truth/fire` GeoJSON answer."""
    points: list[tuple[float, float]] = []
    for feature in truth.get("features", []):
        if feature.get("properties", {}).get("class") != "on_fire":
            continue
        geometry = feature.get("geometry", {})
        polygons = geometry.get("coordinates", [])
        if geometry.get("type") == "Polygon":
            polygons = [polygons]
        for polygon in polygons:
            for ring in polygon[:1]:
                points += [(float(lat), float(lon)) for lon, lat, *_ in ring]
    return points


def label_instances(
    labels: NDArray[np.uint8], thermal_k: NDArray[np.float32], night: bool
) -> list[Instance]:
    hot = thermal_k >= FLAME_K
    flame = (labels == ON_FIRE) & hot
    burned = np.isin(labels, (SMOULDERING, BURNED_ID)) | ((labels == ON_FIRE) & ~hot)
    out = mask_instances(flame, FLAME)
    if not night:
        out += mask_instances(burned, BURNED)
    return out


def decode_thermal(png: bytes, shape: tuple[int, int]) -> NDArray[np.float32]:
    """Kelvin from Demo Data's 16-bit deci-kelvin PNG, at `shape` (rows, cols)."""
    with Image.open(io.BytesIO(png)) as im:
        dk = np.asarray(im).astype(np.float32)
    if dk.shape != shape:
        dk = np.asarray(Image.fromarray(dk).resize((shape[1], shape[0]), Image.Resampling.NEAREST))
    out: NDArray[np.float32] = dk / 10.0
    return out


def stage_demo_data(
    url: str,
    out_dir: Path,
    name: str,
    count: int,
    seed: int = 0,
    size: tuple[int, int] = (640, 480),
    client: httpx.Client | None = None,
) -> SourceInfo:
    info = SourceInfo(
        name=name,
        kind="demo-data",
        synthetic=True,
        aerial=True,
        group_block=1,
        license=LICENSE,
        origin=url,
    )
    stager = Stager(out_dir, info)
    rng = random.Random(seed)
    http = client or httpx.Client(base_url=url, timeout=60.0)
    fronts: dict[datetime, list[tuple[float, float]]] = {}
    span = (FIRE_END - FIRE_START).total_seconds()
    tries = 0
    while info.images < count and tries < count * 3:
        tries += 1
        t = FIRE_START + timedelta(minutes=round(rng.uniform(0, span) / 60))
        bucket = t.replace(minute=t.minute - t.minute % 10)
        if bucket not in fronts:
            truth = http.get("/v1/truth/fire", params={"t": bucket.isoformat()})
            fronts[bucket] = fire_points(truth.json()) if truth.is_success else []
        shot = plan_shot(rng, t, fronts[bucket])
        params: dict[str, str | float | int] = {
            "lat": round(shot.lat, 6),
            "lon": round(shot.lon, 6),
            "alt_m": round(shot.alt_m, 1),
            "heading_deg": round(shot.heading_deg, 1),
            "pitch_deg": round(shot.pitch_deg, 1),
            "t": shot.t.isoformat(),
            "width": size[0],
            "height": size[1],
            "hfov_deg": 84.0,
            "thermal_width": size[0],
            "images": "rgb,thermal,labels",
            "truth": "true",
        }
        res = http.get("/v1/observation", params=params)
        if not res.is_success:
            stager.notes["failed_requests"] += 1
            continue
        obs = res.json()
        images = obs["images"]
        rgb = base64.b64decode(images["rgb"]["data"])
        with Image.open(io.BytesIO(base64.b64decode(images["labels"]["data"]))) as im:
            labels = np.asarray(im)
        if np.mean(labels == SKY) > 0.9:
            stager.notes["skipped_sky"] += 1
            continue
        thermal = decode_thermal(base64.b64decode(images["thermal"]["data"]), labels.shape)
        night = bool(obs.get("environment", {}).get("is_night", False))
        stager.notes["night_frames"] += night
        stem = f"{shot.t:%H%M}_{shot.alt_m:.0f}m_{-shot.pitch_deg:.0f}deg"
        stager.add(stem, rgb, ".jpg", label_instances(labels, thermal, night))
    return stager.finish()
