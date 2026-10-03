"""Fire state at any scenario time, derived from the arrival-time field built by build.py.

Ground-truth classes (uint8):
    0 NO_RISK     unburned, no fire nearby
    1 AT_RISK     unburned, inside the ember zone of active fire (downwind) or close to it
    2 ON_FIRE     active flames
    3 SMOULDERING hot after the flames pass (embers, collapsed structures)
    4 BURNED      burned out, cool
    5 WATER
    255 NO_DATA   sky or outside coverage (only in rendered frames)
"""

from __future__ import annotations

import json
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

import numpy as np
from scipy import ndimage
from scipy.signal import fftconvolve

from ..config import DERIVED_DIR, FIRE_WIND_FROM_DEG, REKINDLE, MORNING_CONTAINED
from .build import FUELS
from .grid import GRID, load_raster

NO_RISK, AT_RISK, ON_FIRE, SMOULDERING, BURNED, WATER, NO_DATA = 0, 1, 2, 3, 4, 5, 255
CLASS_NAMES = {NO_RISK: "no_risk", AT_RISK: "at_risk", ON_FIRE: "on_fire", SMOULDERING: "smouldering",
               BURNED: "burned", WATER: "water", NO_DATA: "no_data"}

EMBER_RANGE_M = 600.0  # downwind ember exposure counted as "at risk"
NEAR_RANGE_M = 120.0  # any direction


def minutes_since_rekindle(t: datetime) -> float:
    return (t - REKINDLE).total_seconds() / 60.0


@dataclass
class FireFields:
    """Per-cell fields on the analysis grid at one moment."""

    minute: float
    classes: np.ndarray  # uint8, see module docstring
    intensity: np.ndarray  # 0..1 flaming intensity
    smoulder: np.ndarray  # 0..1 smouldering heat
    smoke: np.ndarray  # 0..~2 smoke column density (optical depth units)
    glow: np.ndarray  # 0..1 firelight illuminating the ground
    post_visible: np.ndarray  # 0..1 how much of the post-fire surface shows (flames passed)
    temperature_k: np.ndarray  # surface brightness temperature


def _oriented_kernel(length_m: float, half_angle_deg: float, near_m: float) -> np.ndarray:
    """Binary kernel: a downwind wedge plus a disc. Kernel centre is the source cell."""
    k = int(math.ceil(max(length_m, near_m) / GRID.res))
    rr, cc = np.mgrid[-k : k + 1, -k : k + 1]
    east, north = cc * GRID.res, -rr * GRID.res
    dist = np.hypot(east, north)
    to = math.radians((FIRE_WIND_FROM_DEG + 180) % 360)
    bearing = np.arctan2(east, north)
    diff = np.abs((bearing - to + np.pi) % (2 * np.pi) - np.pi)
    wedge = (dist <= length_m) & (diff <= math.radians(half_angle_deg))
    return (wedge | (dist <= near_m)).astype(np.float32)


@lru_cache(maxsize=1)
def _plume_kernel() -> np.ndarray:
    """Smoke plume: elongated downwind, widening with distance, decaying slowly."""
    length = 3000.0
    k = int(length / GRID.res)
    rr, cc = np.mgrid[-k : k + 1, -k : k + 1]
    east, north = cc * GRID.res, -rr * GRID.res
    to = math.radians((FIRE_WIND_FROM_DEG + 180) % 360)
    along = east * math.sin(to) + north * math.cos(to)
    across = east * math.cos(to) - north * math.sin(to)
    width = 40.0 + 0.25 * np.maximum(along, 0)
    plume = np.where(along >= -40, np.exp(-0.5 * (across / width) ** 2) * np.exp(-np.maximum(along, 0) / 1800.0), 0.0)
    plume /= width / 40.0  # spreading dilutes
    # Hot gases rise straight up before the plume bends over, so the column right above the
    # flames is thin and the smoke thickens a few hundred metres downwind.
    plume *= 0.15 + 0.85 * (1.0 - np.exp(-np.maximum(along, 0) / 220.0))
    return (plume / plume.sum()).astype(np.float32)


class FireScenario:
    """Loads the derived rasters once and evaluates the fire state at any time."""

    def __init__(self):
        self.arrival = load_raster(DERIVED_DIR / "arrival.tif").astype(np.float32)
        self.burned = load_raster(DERIVED_DIR / "burned.tif").astype(bool)
        self.fuel = load_raster(DERIVED_DIR / "fuel.tif")
        self.water = self.fuel == 7
        self.spots = json.loads((DERIVED_DIR / "spot_fires.json").read_text())
        # Cells that visibly burn: the Sentinel-2 burn scar plus spot-fire sightings.
        rr, cc = np.mgrid[0 : GRID.shape[0], 0 : GRID.shape[1]]
        spot_mask = np.zeros(GRID.shape, dtype=bool)
        for s in self.spots:
            r, c = GRID.lonlat_to_rc(s["lon"], s["lat"])
            spot_mask |= (rr - r) ** 2 + (cc - c) ** 2 <= (s["radius_m"] / GRID.res) ** 2
        self.burns = (self.burned | spot_mask) & np.isfinite(self.arrival) & ~self.water
        lut = lambda key: np.array([FUELS.get(i, FUELS[0])[key] for i in range(256)], dtype=np.float32)  # noqa: E731
        self.flame_min = np.maximum(lut("flame")[self.fuel], 3.0)
        self.smoulder_min = np.maximum(lut("smoulder")[self.fuel], 10.0)
        self.heat = np.maximum(lut("heat")[self.fuel], 0.3)
        # The morning fire was contained at 09:00: no flames after that, only hidden heat.
        morning_end = minutes_since_rekindle(MORNING_CONTAINED)
        morning = self.arrival < 0
        self.flame_min[morning] = np.minimum(self.flame_min[morning], morning_end - self.arrival[morning])
        self._at_risk_kernel = _oriented_kernel(EMBER_RANGE_M, 30.0, NEAR_RANGE_M)
        import rasterio

        with rasterio.open(DERIVED_DIR / "buildings_2m.tif") as src:
            self.buildings_hr = (src.read(1) > 0).astype(np.uint8) * 255  # 0/255 for 8-bit sampling
            self.buildings_hr_res = src.transform.a
        self._cache: OrderedDict[int, FireFields] = OrderedDict()
        self._poly_cache: dict = {}
        self._lock = threading.Lock()

    def ambient_k(self, minute: float) -> float:
        """Rough diurnal surface temperature (Lahaina, August)."""
        hour = (14 + 52 / 60 + minute / 60) % 24
        return 299.0 + 4.5 * math.cos((hour - 14.0) / 24 * 2 * math.pi)

    def fields(self, t: datetime) -> FireFields:
        """Fire fields at time t, cached per scenario minute."""
        minute = math.floor(minutes_since_rekindle(t))
        with self._lock:
            if minute in self._cache:
                self._cache.move_to_end(minute)
                return self._cache[minute]
        f = self._compute(float(minute))
        with self._lock:
            self._cache[minute] = f
            while len(self._cache) > 48:
                self._cache.popitem(last=False)
        return f

    def _compute(self, m: float) -> FireFields:
        since = np.where(self.burns, m - self.arrival, np.nan)
        with np.errstate(invalid="ignore"):
            burning = (since >= 0) & (since < self.flame_min)
            smouldering = (since >= self.flame_min) & (since < self.flame_min + self.smoulder_min)
            burned_out = since >= self.flame_min + self.smoulder_min
            x = np.where(burning, since / self.flame_min, 0.0)
        # Fast build-up, slow decay.
        intensity = np.where(burning, self.heat * np.minimum(1.0, x / 0.12) * np.sqrt(np.clip(1.0 - x, 0, 1)) * 1.1, 0.0)
        intensity = np.clip(intensity, 0, 1).astype(np.float32)
        y = np.where(smouldering, (since - self.flame_min) / self.smoulder_min, 0.0)
        smoulder = np.where(smouldering, self.heat * 0.6 * np.exp(-3.0 * y), 0.0).astype(np.float32)

        classes = np.full(GRID.shape, NO_RISK, dtype=np.uint8)
        active = intensity > 0.02
        if active.any():
            # Kernel offsets are (target - source), so plain convolution spreads risk downwind.
            reach = fftconvolve(active.astype(np.float32), self._at_risk_kernel, mode="same") > 0.5
        else:
            reach = np.zeros(GRID.shape, dtype=bool)
        unburned = ~(burning | smouldering | burned_out)
        classes[unburned & reach] = AT_RISK
        classes[burned_out] = BURNED
        classes[smouldering] = SMOULDERING
        classes[burning] = ON_FIRE
        classes[self.water] = WATER

        source = intensity + 0.25 * smoulder
        if source.any():
            # Sub-linear so a small grass fire still shows a plume and the peak stays below
            # total blackout (optical depth ~2.5 at the 16:30 peak, ~0.5 overnight).
            raw = np.maximum(fftconvolve(source, _plume_kernel(), mode="same"), 0.0)
            smoke = np.clip(6.0 * raw**0.6, 0, 3).astype(np.float32)
            glow = ndimage.gaussian_filter(intensity, sigma=4.0) * 3.0 + ndimage.gaussian_filter(smoulder, sigma=2.0) * 0.6
            glow = np.clip(glow, 0, 1).astype(np.float32)
        else:
            smoke = np.zeros(GRID.shape, dtype=np.float32)
            glow = np.zeros(GRID.shape, dtype=np.float32)

        with np.errstate(invalid="ignore"):
            post_visible = np.clip(np.where(self.burns, (since - 0.5 * self.flame_min) / (0.5 * self.flame_min), 0.0), 0, 1)
        post_visible = np.nan_to_num(post_visible).astype(np.float32)
        # Display fields are softened slightly so the 10 m cells do not show as squares.
        intensity = ndimage.gaussian_filter(intensity, 0.8)
        smoulder = ndimage.gaussian_filter(smoulder, 0.8)
        post_visible = ndimage.gaussian_filter(post_visible, 0.8)

        amb = self.ambient_k(m)
        temp = np.full(GRID.shape, amb, dtype=np.float32)
        temp = np.where(burned_out, amb + 3.0, temp)
        temp = np.where(smouldering, amb + 40.0 + 420.0 * smoulder, temp)
        temp = np.where(burning, 650.0 + 550.0 * intensity, temp)
        temp = np.where(self.water, amb - 2.0, temp).astype(np.float32)
        return FireFields(m, classes, intensity, smoulder, smoke, glow, post_visible, temp)

    def class_polygons(self, t: datetime, classes=(AT_RISK, ON_FIRE, SMOULDERING, BURNED)) -> dict:
        """GeoJSON (lon/lat) polygons of each fire class at time t, simplified to ~3 m."""
        from rasterio.features import shapes
        from shapely.geometry import mapping, shape
        from shapely.ops import transform, unary_union

        from ..geo import from_utm

        minute = math.floor(minutes_since_rekindle(t))
        key = ("polys", minute, tuple(classes))
        with self._lock:
            cached = self._poly_cache.get(key)
        if cached is not None:
            return cached
        f = self.fields(t)
        feats = []
        for k in classes:
            mask = f.classes == k
            if not mask.any():
                continue
            geoms = [shape(g) for g, v in shapes(mask.astype(np.uint8), mask=mask, transform=GRID.transform) if v == 1]
            merged = unary_union(geoms).simplify(3.0)
            ll = transform(lambda x, y, z=None: from_utm(x, y), merged)
            feats.append({"type": "Feature", "properties": {"class": CLASS_NAMES[k], "class_id": int(k),
                                                            "area_m2": round(merged.area, 1)},
                          "geometry": mapping(ll)})
        out = {"type": "FeatureCollection", "features": feats}
        with self._lock:
            self._poly_cache[key] = out
            if len(self._poly_cache) > 16:
                self._poly_cache.pop(next(iter(self._poly_cache)))
        return out

    def summary(self, t: datetime) -> dict:
        f = self.fields(t)
        cell_area = GRID.res**2
        counts = np.bincount(f.classes.ravel(), minlength=6)
        return {
            "minutes_since_rekindle": f.minute,
            "area_m2": {CLASS_NAMES[i]: float(counts[i] * cell_area) for i in range(6)},
            "burned_or_burning_acres": float((counts[ON_FIRE] + counts[SMOULDERING] + counts[BURNED]) * cell_area / 4046.86),
        }


_scenario: FireScenario | None = None
_scenario_lock = threading.Lock()


def scenario() -> FireScenario:
    global _scenario
    with _scenario_lock:
        if _scenario is None:
            _scenario = FireScenario()
        return _scenario
