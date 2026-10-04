"""Ground rasters (land cover, fuels, fire timing, building footprints, roads) looked up at
world-frame points."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np
import numpy.typing as npt
import rasterio
from PIL import Image, ImageDraw

from ..config import RAW_DIR
from ..geo import to_utm
from ..model.grid import GRID
from ..model.state import scenario
from .frame import FRAME

# ESA WorldCover 2021 classes.
(
    TREE_COVER,
    SHRUBLAND,
    GRASSLAND,
    CROPLAND,
    BUILT_UP,
    BARE,
    SNOW,
    WATER,
    WETLAND,
    MANGROVES,
    MOSS,
) = (10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100)
WATER_FUEL = 7
NEVER = 1.0e6  # arrival minute for cells the fire never reaches

ROAD_WIDTH_M = {
    "motorway": 14.0,
    "trunk": 12.0,
    "primary": 11.0,
    "secondary": 10.0,
    "tertiary": 8.0,
    "residential": 7.0,
    "unclassified": 7.0,
    "living_street": 6.0,
    "service": 5.0,
}


@dataclass
class GroundLayers:
    worldcover: np.ndarray
    fuel: np.ndarray
    arrival: np.ndarray  # minutes after the rekindle; NEVER where the fire does not burn
    flame_min: np.ndarray
    smoulder_min: np.ndarray
    heat: np.ndarray
    buildings_hr: np.ndarray  # bool, 2 m
    buildings_hr_res: float

    def cells(
        self, x: npt.ArrayLike, y: npt.ArrayLike
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Nearest analysis-grid (row, col) of world points, plus whether they fall on the grid."""
        lon, lat = FRAME.to_lonlat(x, y)
        e, n = to_utm(np.ravel(lon), np.ravel(lat))
        r, c = GRID.utm_to_rc(e, n)
        r, c = np.round(r).astype(np.int64), np.round(c).astype(np.int64)
        inside = (r >= 0) & (r < GRID.height) & (c >= 0) & (c < GRID.width)
        shape = np.shape(x)
        return (
            np.clip(r, 0, GRID.height - 1).reshape(shape),
            np.clip(c, 0, GRID.width - 1).reshape(shape),
            inside.reshape(shape),
        )

    def building(self, x: npt.ArrayLike, y: npt.ArrayLike) -> np.ndarray:
        lon, lat = FRAME.to_lonlat(x, y)
        e, n = to_utm(np.ravel(lon), np.ravel(lat))
        res = self.buildings_hr_res
        r = np.round((GRID.north - np.asarray(n)) / res - 0.5).astype(np.int64)
        c = np.round((np.asarray(e) - GRID.west) / res - 0.5).astype(np.int64)
        h, w = self.buildings_hr.shape
        inside = (r >= 0) & (r < h) & (c >= 0) & (c < w)
        out = np.zeros(r.shape, dtype=bool)
        out[inside] = self.buildings_hr[r[inside], c[inside]]
        return out.reshape(np.shape(x))


@lru_cache(maxsize=1)
def ground_layers() -> GroundLayers:
    sc = scenario()
    with rasterio.open(RAW_DIR / "worldcover_2021.tif") as src:
        wc = src.read(1)
    if wc.shape != GRID.shape:
        raise ValueError(
            "worldcover_2021.tif is not on the analysis grid; rerun `demo-data download --only "
            "worldcover`"
        )
    arrival = np.where(sc.burns, sc.arrival, NEVER).astype(np.float32)
    return GroundLayers(
        worldcover=wc,
        fuel=sc.fuel,
        arrival=arrival,
        flame_min=sc.flame_min.astype(np.float32),
        smoulder_min=sc.smoulder_min.astype(np.float32),
        heat=np.where(sc.burns, sc.heat, 0.0).astype(np.float32),
        buildings_hr=sc.buildings_hr > 0,
        buildings_hr_res=float(sc.buildings_hr_res),
    )


@lru_cache(maxsize=1)
def roads() -> list[tuple[np.ndarray, float]]:
    """Named OpenStreetMap roads as world-frame polylines with a paved width."""
    osm = json.loads((RAW_DIR / "osm_lahaina.json").read_text(encoding="utf-8"))
    out = []
    for e in osm.get("elements", []):
        width = ROAD_WIDTH_M.get(e.get("tags", {}).get("highway", ""))
        if e.get("type") != "way" or width is None or len(e.get("geometry", [])) < 2:
            continue
        lon = np.array([p["lon"] for p in e["geometry"]])
        lat = np.array([p["lat"] for p in e["geometry"]])
        x, y = FRAME.to_local(lon, lat)
        out.append((np.stack([x, y], 1), width))
    return out


def road_lines() -> list[dict[str, Any]]:
    """The roads as the viewer's `roads.json` rows: paved width and world-frame points to 0.1 m."""
    return [{"width_m": width, "points": np.round(line, 1).tolist()} for line, width in roads()]


def road_mask(x0: float, y_top: float, n: int, res: float) -> np.ndarray:
    """Road pixels of an n x n block whose top-left corner is (x0, y_top), rows running south."""
    img = Image.new("L", (n, n), 0)
    draw = ImageDraw.Draw(img)
    x1, y_bottom = x0 + n * res, y_top - n * res
    for line, width in roads():
        if (
            line[:, 0].max() < x0 - width
            or line[:, 0].min() > x1 + width
            or line[:, 1].max() < y_bottom - width
            or line[:, 1].min() > y_top + width
        ):
            continue
        px = [((x - x0) / res, (y_top - y) / res) for x, y in line]
        draw.line(px, fill=255, width=max(1, round(width / res)))
    return np.asarray(img) > 0
