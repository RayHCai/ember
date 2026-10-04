"""Build the derived rasters that drive the synthetic fire.

Real inputs:  Sentinel-2 burn scar (Aug 3 vs Aug 13), the official WFIGS perimeter, ESA
              WorldCover fuels, pre-fire building footprints, the rekindle origin, and the
              time-stamped FSRI sightings (anchors.csv).
Synthetic:    the arrival time of the fire at each 10 m cell between those sightings, from an
              anisotropic (wind-driven) shortest-travel-time spread model whose local speeds
              are adjusted until it reproduces the sightings.

Outputs (data/derived/):
    burned.tif        1 where the fire burned (from Sentinel-2 dNBR inside the perimeter)
    fuel.tif          fuel class (see FUELS)
    arrival.tif       minutes since the 14:52 rekindle when the fire reaches each cell
                      (negative for the morning fire, NaN where fire never arrives)
    structures.geojson  pre-fire buildings with arrival time and fate
    spot_fires.json   sightings the continuous front cannot explain, kept as spot fires
    calibration.json  per-anchor observed vs modelled times
"""

from __future__ import annotations

import csv
import json
import logging
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy import ndimage
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform
from shapely.strtree import STRtree

from ..config import (
    ANCHORS_CSV,
    DERIVED_DIR,
    FIRE_WIND_FROM_DEG,
    HST,
    MORNING_IGNITION,
    ORIGIN_LAT,
    ORIGIN_LON,
    RAW_DIR,
    REKINDLE,
    UTM_EPSG,
)
from ..geo import from_utm, to_utm
from .grid import GRID, save_raster

log = logging.getLogger(__name__)

# Fuel classes. Speeds are wind-driven head-fire rates (m/min) before calibration; durations
# are minutes of flaming and of smouldering after the front passes.
FUELS: dict[int, dict[str, Any]] = {
    0: dict(name="none", speed=0.0, flame=0, smoulder=0, heat=0.0),
    1: dict(name="grass", speed=45.0, flame=5, smoulder=20, heat=0.55),
    2: dict(name="shrub", speed=40.0, flame=8, smoulder=40, heat=0.65),
    3: dict(name="tree", speed=20.0, flame=25, smoulder=240, heat=0.8),
    4: dict(name="urban", speed=15.0, flame=45, smoulder=480, heat=0.75),
    5: dict(name="structure", speed=12.0, flame=110, smoulder=1080, heat=1.0),
    6: dict(name="bare", speed=8.0, flame=3, smoulder=10, heat=0.2),
    7: dict(name="water", speed=0.0, flame=0, smoulder=0, heat=0.0),
}
WORLDCOVER_TO_FUEL = {10: 3, 20: 2, 30: 1, 40: 1, 50: 4, 60: 6, 80: 7, 90: 1, 95: 3, 100: 1}

LENGTH_TO_BREADTH = 1.6  # fire ellipse shape under strong wind
DNBR_BURNED = 0.15
REPORT_LAG_MIN = 3.0  # reports trail the fire's arrival slightly
SPOT_THRESHOLD_MIN = 40.0  # model later than a sighting by more than this -> spot fire
SPOT_RADIUS_M = 40.0


def _utm_geom(geojson_geom: dict[str, Any]) -> BaseGeometry:
    return transform(lambda x, y, z=None: to_utm(x, y), shape(geojson_geom))


def _read_bands(path: Path) -> dict[str, np.ndarray]:
    with rasterio.open(path) as src:
        return {src.descriptions[i]: src.read(i + 1) for i in range(src.count)}


def burn_scar() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (burned, perimeter, water) boolean grids."""
    pre = _read_bands(RAW_DIR / "sentinel2" / "S2_20230803.tif")
    post = _read_bands(RAW_DIR / "sentinel2" / "S2_20230813.tif")

    def nbr(d: dict[str, np.ndarray]) -> np.ndarray:
        return np.asarray((d["nir08"] - d["swir22"]) / (d["nir08"] + d["swir22"] + 1e-6))

    dnbr = nbr(pre) - nbr(post)
    ndwi = (pre["green"] - pre["nir"]) / (pre["green"] + pre["nir"] + 1e-6)
    water = ndwi > 0.05
    water = ndimage.binary_opening(water, iterations=1)

    feats = json.loads((RAW_DIR / "wfigs_lahaina_perimeter.geojson").read_text())["features"]
    perim = rasterize(
        [_utm_geom(f["geometry"]) for f in feats], out_shape=GRID.shape, transform=GRID.transform
    ).astype(bool)
    near_perim = ndimage.binary_dilation(
        perim, iterations=5
    )  # 50 m tolerance for the hand-drawn line

    burned = near_perim & (dnbr > DNBR_BURNED) & ~water
    burned = ndimage.binary_opening(burned, structure=np.ones((2, 2)))
    burned = ndimage.binary_closing(burned, iterations=1) & ~water
    labels, n = ndimage.label(burned)
    sizes = ndimage.sum(burned, labels, range(1, n + 1))
    burned &= np.isin(labels, 1 + np.nonzero(sizes >= 5)[0])
    log.info(
        "burn scar: %.0f acres burned (perimeter %.0f acres)",
        burned.sum() * 100 / 4046.86,
        perim.sum() * 100 / 4046.86,
    )
    return burned, perim, water


def load_buildings() -> list[dict[str, Any]]:
    """OSM (2023-08-07) footprints plus Microsoft footprints that do not overlap an OSM one."""
    out = []
    osm = json.loads((RAW_DIR / "buildings_osm_20230807.geojson").read_text())["features"]
    for f in osm:
        g = _utm_geom(f["geometry"])
        if g.is_valid and g.area > 8:
            out.append(
                {
                    "geom": g,
                    "source": "osm",
                    "source_id": f["properties"]["osm_id"],
                    "name": f["properties"].get("name"),
                }
            )
    tree = STRtree([b["geom"] for b in out])
    ms = json.loads((RAW_DIR / "buildings_microsoft.geojson").read_text())["features"]
    added = 0
    for f in ms:
        g = _utm_geom(f["geometry"])
        if not g.is_valid or g.area < 8:
            continue
        hits = tree.query(g, predicate="intersects")
        if len(hits) == 0:
            out.append(
                {"geom": g, "source": "microsoft", "source_id": f["properties"]["id"], "name": None}
            )
            added += 1
    log.info("buildings: %d OSM + %d Microsoft-only", len(out) - added, added)
    return out


def fuels(water: np.ndarray, buildings: list[dict[str, Any]]) -> np.ndarray:
    with rasterio.open(RAW_DIR / "worldcover_2021.tif") as src:
        wc = src.read(1)
    fuel = np.zeros(GRID.shape, dtype=np.uint8)
    for code, f in WORLDCOVER_TO_FUEL.items():
        fuel[wc == code] = f
    footprint = rasterize(
        [b["geom"] for b in buildings],
        out_shape=GRID.shape,
        transform=GRID.transform,
        all_touched=False,
    )
    fuel[footprint.astype(bool)] = 5
    fuel[water] = 7
    return fuel


# --- Spread model ----------------------------------------------------------------------------

_OFFSETS = [
    (dr, dc)
    for dr in (-2, -1, 0, 1, 2)
    for dc in (-2, -1, 0, 1, 2)
    if (dr, dc) != (0, 0) and math.gcd(abs(dr), abs(dc)) == 1
]


class SpreadGraph:
    """Directed travel-time graph over the burnable domain (16-neighbour stencil)."""

    def __init__(self, domain: np.ndarray, base_speed: np.ndarray):
        self.domain = domain
        self.index = np.full(GRID.shape, -1, dtype=np.int64)
        self.rows, self.cols = np.nonzero(domain)
        self.n = len(self.rows)
        self.index[self.rows, self.cols] = np.arange(self.n)
        self.base_speed = base_speed
        e = math.sqrt(1 - 1 / LENGTH_TO_BREADTH**2)
        head = math.radians((FIRE_WIND_FROM_DEG + 180) % 360)
        src, dst, dist, factor = [], [], [], []
        H, W = GRID.shape
        for dr, dc in _OFFSETS:
            r2, c2 = self.rows + dr, self.cols + dc
            ok = (r2 >= 0) & (r2 < H) & (c2 >= 0) & (c2 < W)
            ok[ok] &= domain[r2[ok], c2[ok]]
            bearing = math.atan2(dc, -dr)  # east = +col, north = -row
            src.append(np.nonzero(ok)[0])
            dst.append(self.index[r2[ok], c2[ok]])
            d = GRID.res * math.hypot(dr, dc)
            dist.append(np.full(ok.sum(), d))
            factor.append(np.full(ok.sum(), (1 - e) / (1 - e * math.cos(bearing - head))))
        self.src = np.concatenate(src)
        self.dst = np.concatenate(dst)
        self.dist = np.concatenate(dist)
        self.factor = np.concatenate(factor)

    def solve(self, multiplier: np.ndarray, sources: np.ndarray) -> np.ndarray:
        """Arrival time in minutes for each domain cell; sources start at 0."""
        s = (self.base_speed * multiplier)[self.rows, self.cols]
        s = np.maximum(s, 0.05)
        edge_speed = 2.0 / (1.0 / s[self.src] + 1.0 / s[self.dst]) * self.factor
        w = self.dist / edge_speed
        g = csr_matrix((w, (self.src, self.dst)), shape=(self.n, self.n))
        idx = self.index[sources[:, 0], sources[:, 1]]
        t = dijkstra(g, directed=True, indices=idx[idx >= 0], min_only=True)
        out = np.full(GRID.shape, np.nan, dtype=np.float32)
        out[self.rows, self.cols] = t
        out[~np.isfinite(out)] = np.nan
        return out


def load_anchors() -> list[dict[str, Any]]:
    anchors = []
    with ANCHORS_CSV.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t = datetime.fromisoformat(row["time_hst"]).replace(tzinfo=HST)
            e, n = to_utm(float(row["lon"]), float(row["lat"]))
            r, c = GRID.utm_to_rc(e, n)
            anchors.append(
                {
                    **row,
                    "t": t,
                    "minutes": (t - REKINDLE).total_seconds() / 60 - REPORT_LAG_MIN,
                    "r": float(r),
                    "c": float(c),
                    "precision": float(row["precision_m"]),
                }
            )
    return anchors


def _anchor_model_time(arrival: np.ndarray, a: dict[str, Any]) -> float:
    """Earliest modelled arrival within the anchor's location uncertainty (capped at 150 m)."""
    rad = max(1.0, min(a["precision"], 150.0) / GRID.res)
    r0, c0 = round(a["r"]), round(a["c"])
    k = math.ceil(rad)
    rs = slice(max(r0 - k, 0), r0 + k + 1)
    cs = slice(max(c0 - k, 0), c0 + k + 1)
    sub = arrival[rs, cs]
    rr, cc = np.mgrid[rs, cs]
    disk = (rr - a["r"]) ** 2 + (cc - a["c"]) ** 2 <= rad**2
    vals = sub[disk & np.isfinite(sub)]
    return float(vals.min()) if vals.size else float("nan")


def calibrate(
    graph: SpreadGraph, sources: np.ndarray, anchors: list[dict[str, Any]], iterations: int = 150
) -> tuple[np.ndarray, np.ndarray]:
    """Scale local spread speeds until modelled arrivals agree with the sightings.

    A sighting says "fire was here by time T". Many evening reports describe areas that had
    been burning for a while ("highway unpassable, flames"), so the model arriving earlier
    than a report is only weakly penalised, while arriving later (fire reported where the
    model has none yet) is penalised fully.
    """
    log_mult = np.zeros(GRID.shape, dtype=np.float64)
    usable = [a for a in anchors if a["minutes"] > 15]  # earlier ones sit on the origin
    rr, cc = np.mgrid[0 : GRID.shape[0], 0 : GRID.shape[1]]
    sigma = 300.0 / GRID.res
    kernels = [
        np.exp(-((rr - a["r"]) ** 2 + (cc - a["c"]) ** 2) / (2 * sigma**2)).astype(np.float32)
        for a in usable
    ]
    weights = np.array([1.0 / (1.0 + (a["precision"] / 100.0) ** 2) for a in usable])
    obs = np.array([a["minutes"] for a in usable])
    best_loss = float("inf")
    best_fit: tuple[np.ndarray, np.ndarray] | None = None
    for it in range(iterations + 1):
        arrival = graph.solve(np.exp(log_mult), sources)
        model = np.array([_anchor_model_time(arrival, a) for a in usable])
        ok = np.isfinite(model)
        diff = np.where(ok, model - obs, 0.0)
        res = np.where(ok, np.log((np.where(ok, model, 0) + 10) / (obs + 10)), 0.0)  # >0: late
        early_ok = (diff < 0) & (diff > -30)
        res = np.where(res < 0, np.where(early_ok, 0.0, 0.7 * res), res)
        # A sighting the front cannot reach without wrecking its neighbours is probably a spot fire.
        robust = np.where(res > 1.0, 0.25, 1.0) * weights * ok
        loss = float(np.sum(robust * res**2))
        late = int(np.sum(ok & (diff > 15)))
        log.info(
            "calibration %2d: loss %.3f, median |err| %.1f min, %d sightings >15 min ahead of the "
            "model",
            it,
            loss,
            np.median(np.abs(diff[ok])),
            late,
        )
        if loss < best_loss:
            best_loss = loss
            best_fit = (arrival, np.exp(log_mult).astype(np.float32))
        if it == iterations:
            break
        num = sum(w * r * k for w, r, k in zip(robust, res, kernels, strict=True))
        den = sum(w * k for w, k in zip(robust, kernels, strict=True)) + 0.05
        log_mult = np.clip(log_mult + 0.5 * num / den, math.log(0.03), math.log(25))
    if best_fit is None:
        raise RuntimeError("calibration never produced a finite loss")
    return best_fit


OUTPUTS = (
    "burned.tif",
    "perimeter.tif",
    "fuel.tif",
    "arrival.tif",
    "speed_multiplier.tif",
    "spot_fires.json",
    "calibration.json",
    "structures.geojson",
    "buildings_2m.tif",
)


def is_built() -> bool:
    return all((DERIVED_DIR / name).exists() for name in OUTPUTS)


def build_all(force: bool = False) -> None:
    if not force and is_built():
        log.info("fire model already built in %s; use --force to rebuild", DERIVED_DIR)
        return
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    burned, perim, water = burn_scar()
    buildings = load_buildings()
    fuel = fuels(water, buildings)

    domain = (ndimage.binary_dilation(perim, iterations=15) | burned) & (fuel != 7) & (fuel != 0)
    base_speed = np.zeros(GRID.shape, dtype=np.float64)
    for code, f in FUELS.items():
        base_speed[fuel == code] = f["speed"]
    # Roads and lots inside the town still pass embers; keep a floor so the front can cross them.
    base_speed = np.where(domain, np.maximum(base_speed, 6.0), 0.0)
    graph = SpreadGraph(domain, base_speed)

    # Morning fire: a small patch at the origin burned 06:34-~07:00 and was declared contained
    # at 09:00; the afternoon fire rekindled from its edge.
    oe, on = to_utm(ORIGIN_LON, ORIGIN_LAT)
    orow, ocol = GRID.utm_to_rc(oe, on)
    rr, cc = np.mgrid[0 : GRID.shape[0], 0 : GRID.shape[1]]
    morning = ((rr - orow) ** 2 + (cc - ocol) ** 2 <= (45 / GRID.res) ** 2) & domain
    sources = np.argwhere(morning)
    log.info("origin cell (%.1f, %.1f); morning patch %d cells", orow, ocol, morning.sum())

    anchors = load_anchors()
    arrival, multiplier = calibrate(graph, sources, anchors)

    morning_minutes = (MORNING_IGNITION - REKINDLE).total_seconds() / 60
    dist = np.hypot(rr - orow, cc - ocol) * GRID.res
    arrival = np.where(morning, morning_minutes + dist / 3.0, arrival)  # ~3 m/min morning spread

    # Sightings the front reaches far too late are kept as isolated spot fires.
    spots, report = [], []
    for a in anchors:
        model = _anchor_model_time(arrival, a)
        late = model - a["minutes"]
        report.append(
            {
                "id": a["id"],
                "time_hst": a["time_hst"],
                "lat": float(a["lat"]),
                "lon": float(a["lon"]),
                "observed_min": round(a["minutes"], 1),
                "model_min": None if math.isnan(model) else round(model, 1),
                "error_min": None if math.isnan(model) else round(late, 1),
                "quote": a["quote"],
            }
        )
        if a["minutes"] > 15 and (math.isnan(model) or late > SPOT_THRESHOLD_MIN):
            spots.append(
                {
                    "id": a["id"],
                    "lat": float(a["lat"]),
                    "lon": float(a["lon"]),
                    "minutes": a["minutes"],
                    "radius_m": SPOT_RADIUS_M,
                    "quote": a["quote"],
                }
            )
    for s in spots:
        e, n = to_utm(s["lon"], s["lat"])
        r, c = GRID.utm_to_rc(e, n)
        blob = ((rr - r) ** 2 + (cc - c) ** 2 <= (s["radius_m"] / GRID.res) ** 2) & domain
        arrival = np.where(blob & ~(arrival <= s["minutes"]), s["minutes"], arrival)
    log.info("spot fires: %s", [s["id"] for s in spots])

    spot_ids = {s["id"] for s in spots}
    front = [
        r
        for r in report
        if r["error_min"] is not None and r["id"] not in spot_ids and r["observed_min"] > 15
    ]
    errs = np.array([r["error_min"] for r in front])
    summary = {
        "anchors": len(report),
        "explained_by_front": len(front),
        "spot_fires": len(spots),
        "outside_burnable_area": sum(r["error_min"] is None for r in report),
        "median_abs_error_min": round(float(np.median(np.abs(errs))), 1),
        "front_within_15_min_or_earlier": int(np.sum(errs <= 15)),
        "front_earlier_than_report_by_over_60_min": int(np.sum(errs < -60)),
    }
    log.info("calibration summary: %s", summary)

    save_raster(DERIVED_DIR / "burned.tif", burned.astype(np.uint8), nodata=None)
    save_raster(DERIVED_DIR / "perimeter.tif", perim.astype(np.uint8), nodata=None)
    save_raster(DERIVED_DIR / "fuel.tif", fuel, nodata=None)
    save_raster(DERIVED_DIR / "arrival.tif", arrival.astype(np.float32), nodata=float("nan"))
    save_raster(DERIVED_DIR / "speed_multiplier.tif", multiplier, nodata=None)
    (DERIVED_DIR / "spot_fires.json").write_text(json.dumps(spots, indent=1))
    (DERIVED_DIR / "calibration.json").write_text(
        json.dumps({"summary": summary, "anchors": report}, indent=1)
    )
    _write_structures(buildings, burned, arrival)
    _write_building_mask(buildings)


BUILDING_MASK_RES = 2.0


def _write_building_mask(buildings: list[dict[str, Any]]) -> None:
    """Building footprints at 2 m on the analysis grid's extent, so flames and embers can sit
    on the actual structures instead of filling whole 10 m cells."""
    k = int(GRID.res / BUILDING_MASK_RES)
    shape_hr = (GRID.height * k, GRID.width * k)
    transform_hr = from_origin(GRID.west, GRID.north, BUILDING_MASK_RES, BUILDING_MASK_RES)
    mask = rasterize(
        [b["geom"] for b in buildings],
        out_shape=shape_hr,
        transform=transform_hr,
        all_touched=True,
        dtype="uint8",
    )
    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 1,
        "width": shape_hr[1],
        "height": shape_hr[0],
        "crs": f"EPSG:{UTM_EPSG}",
        "transform": transform_hr,
        "compress": "deflate",
    }
    with rasterio.open(DERIVED_DIR / "buildings_2m.tif", "w", **profile) as dst:
        dst.write(mask[None])
    log.info("building mask: %d cells at %.0f m", int(mask.sum()), BUILDING_MASK_RES)


def _write_structures(
    buildings: list[dict[str, Any]], burned: np.ndarray, arrival: np.ndarray
) -> None:
    feats: list[dict[str, Any]] = []
    shapes = [(b["geom"], i + 1) for i, b in enumerate(buildings)]
    ids = rasterize(
        shapes, out_shape=GRID.shape, transform=GRID.transform, all_touched=True, dtype="int32"
    )
    for i, b in enumerate(buildings):
        cells = ids == i + 1
        n = int(cells.sum())
        frac = float(burned[cells].mean()) if n else 0.0
        times = arrival[cells & burned]
        fate = "destroyed" if frac >= 0.4 else "survived"
        minutes = (
            float(np.nanmin(times)) if fate == "destroyed" and np.isfinite(times).any() else None
        )
        c = b["geom"].centroid
        lon, lat = from_utm(c.x, c.y)
        ring = [list(from_utm(x, y)) for x, y in b["geom"].exterior.coords]
        feats.append(
            {
                "type": "Feature",
                "properties": {
                    "id": i,
                    "source": b["source"],
                    "source_id": b["source_id"],
                    "name": b["name"],
                    "area_m2": round(b["geom"].area, 1),
                    "lat": round(lat, 6),
                    "lon": round(lon, 6),
                    "fate": fate,
                    "ignition_min": None if minutes is None else round(minutes, 1),
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[round(x, 7), round(y, 7)] for x, y in ring]],
                },
            }
        )
    (DERIVED_DIR / "structures.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats})
    )
    destroyed = sum(f["properties"]["fate"] == "destroyed" for f in feats)
    log.info("structures: %d total, %d destroyed", len(feats), destroyed)
