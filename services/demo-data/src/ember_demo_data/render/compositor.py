"""Turns ground points and a time into what a drone's RGB and thermal cameras would record.

Imagery epochs:
    before 06:34 Aug 8         pre-fire imagery (real)
    06:34 Aug 8 - 11:20 Aug 9  SYNTHETIC: pre-fire imagery where the fire has not arrived,
                               real post-fire imagery where it has passed, with flames,
                               embers, smoke and night lighting from the fire model
    11:20 Aug 9 - 11:12 Aug 12 Maxar Aug 9 (real; smoke plumes in the image itself)
    11:12 Aug 12 - Aug 14      Maxar Aug 12 (real)
    Aug 14 onward              WaldoAir Aug 14 (real, 10 cm) where covered
Missing tiles fall through to the next layer in each chain.

Flames, embers and the thermal image are all driven by one per-pixel fire texture that sits
on the 2 m building footprints, so what the RGB camera shows burning is what the thermal
camera reads as hot.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np

from ..config import AOI, LAYERS, MORNING_IGNITION
from ..geo import to_utm
from ..model.grid import GRID
from ..model.state import (
    AT_RISK,
    BURNED,
    NO_DATA,
    NO_RISK,
    ON_FIRE,
    SMOULDERING,
    WATER,
    FireFields,
    scenario,
)
from ..tiles import sampler
from . import noise
from .noise import smoothstep
from .sampling import Bilinear
from .sun import daylight, sun_elevation_deg

POST_CHAIN = ["waldo_20230814", "maxar_20230812", "maxar_20230809"]


@dataclass(frozen=True)
class Epoch:
    name: str
    synthetic: bool
    chain: tuple[str, ...]
    description: str


def epoch_for(t: datetime) -> Epoch:
    m0809 = LAYERS["maxar_20230809"].captured
    m0812 = LAYERS["maxar_20230812"].captured
    w0814 = LAYERS["waldo_20230814"].captured
    if t < MORNING_IGNITION:
        return Epoch("pre_fire", False, ("pre_2020",), "Real pre-fire imagery (Feb 2020 capture)")
    if t < m0809:
        return Epoch(
            "fire",
            True,
            ("pre_2020", *POST_CHAIN),
            "Synthetic: pre-fire imagery ahead of the fire, real post-fire imagery behind it, "
            "flames/smoke/lighting from the calibrated fire model",
        )
    if t < m0812:
        return Epoch(
            "smouldering",
            False,
            ("maxar_20230809", "maxar_20230812", "pre_2020"),
            "Real Maxar image from 2023-08-09 11:20 HST (smoke plumes are real)",
        )
    if t < w0814:
        return Epoch(
            "post_fire",
            False,
            ("maxar_20230812", "maxar_20230809", "pre_2020"),
            "Real Maxar image from 2023-08-12 11:12 HST",
        )
    return Epoch(
        "post_fire_aerial",
        False,
        ("waldo_20230814", "maxar_20230812", "maxar_20230809", "pre_2020"),
        "Real WaldoAir aerial survey from 2023-08-14 (10 cm)",
    )


def _chain_sample(
    chain: Sequence[str], lon: np.ndarray, lat: np.ndarray, gsd: float
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    rgb = np.zeros((*lon.shape, 3), dtype=np.float32)
    have = np.zeros(lon.shape, dtype=bool)
    used: dict[str, int] = {}
    for layer_id in chain:
        need = ~have
        if not need.any():
            break
        try:
            s = sampler(layer_id)
        except FileNotFoundError:
            continue
        vals, ok = s.sample(lon[need], lat[need], gsd)
        idx = np.nonzero(need)[0][ok]
        rgb[idx] = vals[ok]
        have[idx] = True
        if idx.size:
            used[layer_id] = int(idx.size)
    return rgb, have, used


@dataclass
class GroundPoints:
    """Ground sample positions in both lon/lat (imagery tiles) and UTM 4N (fire model grid)."""

    lon: np.ndarray
    lat: np.ndarray
    e: np.ndarray
    n: np.ndarray

    @classmethod
    def from_lonlat(cls, lon: np.ndarray, lat: np.ndarray) -> GroundPoints:
        e, n = to_utm(lon, lat)
        return cls(np.asarray(lon), np.asarray(lat), np.asarray(e), np.asarray(n))


@dataclass
class GroundRender:
    rgb: np.ndarray | None  # (n, 3) float 0..1
    thermal_k: np.ndarray | None  # (n,)
    labels: np.ndarray | None  # (n,) uint8
    covered: np.ndarray  # (n,) bool: imagery available (inside the AOI for thermal-only renders)
    layers_used: dict[str, Any] = field(default_factory=dict)


_CLASSES = np.array([NO_RISK, AT_RISK, ON_FIRE, SMOULDERING, BURNED, WATER], dtype=np.uint8)


def _labels(fields: FireFields, bl: Bilinear, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    # Smooth class boundaries: bilinear "votes" per class, then the strongest wins.
    onehot = (fields.classes[:, :, None] == _CLASSES[None, None, :]).astype(np.uint8) * 255
    labels = _CLASSES[bl(onehot).argmax(1)]
    inside = (
        (rows >= -0.5) & (rows <= GRID.height - 0.5) & (cols >= -0.5) & (cols <= GRID.width - 0.5)
    )
    return np.where(inside, labels, NO_DATA).astype(np.uint8)


def lighting(t: datetime) -> tuple[float, np.ndarray, float]:
    """(illumination, colour tint, sun elevation) for the AOI at time t."""
    elev = sun_elevation_deg((AOI.south + AOI.north) / 2, (AOI.west + AOI.east) / 2, t)
    light = daylight(elev)
    tint: np.ndarray
    if elev < -6:
        tint = np.array([0.72, 0.84, 1.15], dtype=np.float32)
    elif elev < 8:
        w = (elev + 6) / 14
        tint = (1 - w) * np.array([0.9, 0.85, 1.0]) + w * np.array([1.08, 0.93, 0.8])
    else:
        tint = np.ones(3)
    return light, tint.astype(np.float32), elev


DEEP_RED = np.array([0.55, 0.06, 0.02], dtype=np.float32)
ORANGE = np.array([1.0, 0.42, 0.06], dtype=np.float32)
WHITE_HOT = np.array([1.0, 0.92, 0.62], dtype=np.float32)
EMBER = np.array([1.0, 0.28, 0.04], dtype=np.float32)
GLOW = np.array([1.0, 0.5, 0.18], dtype=np.float32)
SOOT = np.array([0.07, 0.06, 0.055], dtype=np.float32)


def render_ground(
    pts: GroundPoints,
    t: datetime,
    gsd_m: float,
    path_factor: np.ndarray | None = None,
    seed: int = 0,
    want_rgb: bool = True,
    want_thermal: bool = True,
    want_labels: bool = True,
) -> GroundRender:
    """Render ground points (1-D arrays, all finite) for one moment."""
    ep = epoch_for(t)
    sc = scenario()
    fields = sc.fields(t)
    lon, lat, e, n = pts.lon, pts.lat, pts.e, pts.n
    rows, cols = GRID.utm_to_rc(e, n)
    in_aoi = (lon >= AOI.west) & (lon <= AOI.east) & (lat >= AOI.south) & (lat <= AOI.north)
    minute = fields.minute
    ambient = sc.ambient_k(minute)
    rng = np.random.default_rng(seed)

    bl = Bilinear(rows, cols, GRID.shape)
    inten = bl(fields.intensity)
    sm = bl(fields.smoulder)
    post_w = bl(fields.post_visible)

    # --- per-pixel fire texture (computed only where there is fire) ---------------------------
    flame_a = np.zeros(lon.shape, dtype=np.float32)
    core = np.zeros(lon.shape, dtype=np.float32)
    ember = np.zeros(lon.shape, dtype=np.float32)
    coarse_all = np.full(lon.shape, 0.5, dtype=np.float32)
    hot = (inten > 0.005) | (sm > 0.005)
    if hot.any():
        hi = np.nonzero(hot)[0]
        he, hn = e[hi], n[hi]
        res_hr = sc.buildings_hr_res
        brow = (GRID.north - hn) / res_hr - 0.5
        bcol = (he - GRID.west) / res_hr - 0.5
        bm = Bilinear(brow, bcol, sc.buildings_hr.shape)(sc.buildings_hr) / 255.0
        coarse = noise.sample(he, hn, 3.0, (minute * 9.0, minute * 4.0))  # drifts downwind
        fine = noise.sample(he, hn, 0.7, (minute * 37.0, -minute * 23.0))  # flickers
        it = inten[hi]
        fl = it * (0.2 + 1.2 * coarse) * (0.55 + 0.65 * bm) + 0.3 * (fine - 0.5)
        flame_a[hi] = smoothstep(0.30, 0.55, fl) * (it > 0.005)
        core[hi] = smoothstep(0.62, 0.95, fl) * flame_a[hi]
        # Embers concentrate in building debris; open ground cools quickly.
        ember[hi] = (
            sm[hi] * (0.15 + 1.5 * noise.sample(he, hn, 1.2, (311.0, 97.0))) * (0.2 + 0.8 * bm)
        )
        coarse_all[hi] = coarse

    rgb = None
    covered = in_aoi
    used: dict[str, Any] = {}
    if want_rgb:
        if ep.synthetic:
            pre, have_pre, used = _chain_sample(("pre_2020",), lon, lat, gsd_m)
            need_post = post_w > 0.001
            post = np.zeros_like(pre)
            have_post = np.zeros(lon.shape, dtype=bool)
            if need_post.any():
                p, hp, used_post = _chain_sample(POST_CHAIN, lon[need_post], lat[need_post], gsd_m)
                # Fresh char reads darker than the ash-grey of the days-later post-fire images.
                p *= (0.62 + 0.25 * noise.sample(e[need_post], n[need_post], 5.0))[:, None]
                post[need_post], have_post[need_post] = p, hp
                for key, v in used_post.items():
                    used[key] = used.get(key, 0) + v
            w = np.where(have_post, post_w, 0.0)[:, None]
            base = pre * (1 - w) + post * w
            base = np.where((~have_pre & have_post)[:, None], post, base)
            covered = (have_pre | have_post) & in_aoi
        else:
            base, have, used = _chain_sample(ep.chain, lon, lat, gsd_m)
            covered = have & in_aoi

        light, tint, _ = lighting(t)
        dark = 1.0 - light
        smoke = bl(fields.smoke) if ep.synthetic else np.zeros(lon.shape, dtype=np.float32)
        glow = bl(fields.glow)
        shade = np.exp(-0.45 * smoke)  # smoke overhead blocks sunlight
        rgb = base * (light * tint)[None, :] * shade[:, None]
        rgb += (
            base * GLOW[None, :] * (glow * (0.25 + 1.4 * dark))[:, None]
        )  # firelight matters most at night

        soot_a = np.clip(inten * 1.4 * (1.0 - coarse_all), 0, 0.7) * (1 - flame_a)
        rgb = rgb * (1 - soot_a[:, None]) + SOOT * soot_a[:, None]
        flame_col = DEEP_RED + (ORANGE - DEEP_RED) * np.clip(flame_a * 1.4, 0, 1)[:, None]
        flame_col = flame_col + (WHITE_HOT - flame_col) * core[:, None]
        flame_light = flame_col * 1.1 * flame_a[:, None]
        # Embers are emissive: faint in sunlight, vivid at night.
        ember_light = EMBER * (np.clip(ember, 0, 1.2) ** 1.2 * (0.2 + 2.0 * dark))[:, None]
        rgb = rgb * (1 - flame_a[:, None]) + flame_light + ember_light

        if ep.synthetic and smoke.any():
            pf = path_factor if path_factor is not None else np.ones_like(smoke)
            thick = smoke > 0.01
            billow = np.full(lon.shape, 0.5, dtype=np.float32)
            billow[thick] = noise.sample(e[thick], n[thick], 30.0, (minute * 45.0, minute * 14.0))
            tau = smoke * pf * (0.45 + 1.1 * billow)
            smoke_a = 1.0 - np.exp(-0.8 * tau)
            smoke_col = (
                np.array([0.46, 0.44, 0.41], dtype=np.float32) * light
                + np.array([0.03, 0.028, 0.025], dtype=np.float32)
                + GLOW * ((0.15 + 0.6 * dark) * glow)[:, None]
            )
            rgb = rgb * (1 - smoke_a[:, None]) + smoke_col * smoke_a[:, None]
            # Firelight is much brighter than the sunlit smoke, so it shows through (diffused).
            through = (np.exp(-0.35 * tau) - (1 - smoke_a))[:, None]
            rgb += (flame_light + ember_light) * np.clip(through, 0, 1)

        rgb = rgb + rng.normal(0.0, 0.006 + 0.025 * dark, rgb.shape).astype(np.float32)
        rgb = np.where(
            covered[:, None], rgb, np.array([0.33, 0.35, 0.33], dtype=np.float32) * light
        )
        rgb = np.clip(rgb, 0, 1).astype(np.float32)

    thermal = None
    if want_thermal:
        # LWIR brightness temperature; sees through smoke.
        water = bl(sc.water) > 127
        thermal = np.full(lon.shape, ambient, dtype=np.float32)
        thermal = np.where(post_w > 0.5, ambient + 3.0, thermal)
        thermal = np.where(
            ember > 0.003,
            np.maximum(thermal, ambient + 25.0 + 430.0 * np.clip(ember, 0, 1.2)),
            thermal,
        )
        thermal = np.where(
            flame_a > 0.02,
            np.maximum(thermal, 520.0 + 680.0 * flame_a * (0.6 + 0.4 * core)),
            thermal,
        )
        thermal = np.where(water, ambient - 2.0, thermal)
        thermal = (thermal + rng.normal(0.0, 0.25, thermal.shape)).astype(np.float32)

    labels = None
    if want_labels:
        labels = np.where(in_aoi, _labels(fields, bl, rows, cols), NO_DATA).astype(np.uint8)
    return GroundRender(rgb, thermal, labels, covered, used)


def sky_rgb(ray_elev_deg: np.ndarray, t: datetime, smoky: float) -> np.ndarray:
    light, tint, _ = lighting(t)
    up = np.clip(ray_elev_deg / 60.0, 0, 1)[..., None]
    horizon = np.array([0.78, 0.82, 0.88], dtype=np.float32)
    zenith = np.array([0.35, 0.52, 0.82], dtype=np.float32)
    col: np.ndarray = (horizon * (1 - up) + zenith * up) * light * tint
    smoke_col = np.array([0.5, 0.42, 0.33], dtype=np.float32) * max(light, 0.05) + np.array(
        [0.25, 0.08, 0.02]
    ) * (1 - light)
    s = float(np.clip(smoky, 0, 1))
    col = col * (1 - s) + smoke_col * s
    return np.asarray(
        np.clip(col + np.array([0.01, 0.012, 0.02]) * (1 - light), 0, 1), dtype=np.float32
    )


def fire_smokiness(t: datetime) -> float:
    if not epoch_for(t).synthetic:
        return 0.0
    f = scenario().fields(t)
    return float(min(1.0, np.percentile(f.smoke, 99) / 2.0))


SKY_K = 235.0  # LWIR brightness temperature of clear sky


def clamp_gsd(gsd: float) -> float:
    return gsd if math.isfinite(gsd) and gsd > 0 else 1.0
