"""The analysis grid: UTM zone 4N, 10 m cells, aligned with the Sentinel-2 pixel grid."""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import rasterio
from rasterio.transform import Affine, from_origin

from ..config import AOI, GRID_RES_M, UTM_EPSG
from ..geo import Floats, from_utm, to_utm


@dataclass(frozen=True)
class Grid:
    west: float  # UTM easting of the left edge
    north: float  # UTM northing of the top edge
    width: int
    height: int
    res: float

    @property
    def east(self) -> float:
        return self.west + self.width * self.res

    @property
    def south(self) -> float:
        return self.north - self.height * self.res

    @property
    def shape(self) -> tuple[int, int]:
        return self.height, self.width

    @cached_property
    def transform(self) -> Affine:
        return from_origin(self.west, self.north, self.res, self.res)

    def utm_to_rc(self, easting: npt.ArrayLike, northing: npt.ArrayLike) -> tuple[Floats, Floats]:
        """Fractional (row, col) with cell centres at integer values."""
        col = (np.asarray(easting) - self.west) / self.res - 0.5
        row = (self.north - np.asarray(northing)) / self.res - 0.5
        return row, col

    def lonlat_to_rc(self, lon: npt.ArrayLike, lat: npt.ArrayLike) -> tuple[Floats, Floats]:
        e, n = to_utm(lon, lat)
        return self.utm_to_rc(e, n)

    def rc_to_lonlat(self, row: npt.ArrayLike, col: npt.ArrayLike) -> tuple[Any, Any]:
        e = self.west + (np.asarray(col) + 0.5) * self.res
        n = self.north - (np.asarray(row) + 0.5) * self.res
        return from_utm(e, n)

    def centres_utm(self) -> tuple[np.ndarray, np.ndarray]:
        cols = self.west + (np.arange(self.width) + 0.5) * self.res
        rows = self.north - (np.arange(self.height) + 0.5) * self.res
        xs, ys = np.meshgrid(cols, rows)
        return xs, ys

    def profile(self, dtype: str, count: int = 1, nodata: float | None = None) -> dict[str, Any]:
        return {
            "driver": "GTiff",
            "dtype": dtype,
            "count": count,
            "width": self.width,
            "height": self.height,
            "crs": f"EPSG:{UTM_EPSG}",
            "transform": self.transform,
            "nodata": nodata,
            "compress": "deflate",
        }


def _make_grid() -> Grid:
    lons = [AOI.west, AOI.east, AOI.east, AOI.west]
    lats = [AOI.south, AOI.south, AOI.north, AOI.north]
    es, ns = to_utm(lons, lats)
    r = GRID_RES_M
    west = math.floor(min(es) / r) * r
    east = math.ceil(max(es) / r) * r
    south = math.floor(min(ns) / r) * r
    north = math.ceil(max(ns) / r) * r
    return Grid(
        west=west,
        north=north,
        width=round((east - west) / r),
        height=round((north - south) / r),
        res=r,
    )


GRID = _make_grid()


def save_raster(path: Path, data: np.ndarray, nodata: float | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.asarray(data)
    bands = data[None] if data.ndim == 2 else data
    with rasterio.open(path, "w", **GRID.profile(str(bands.dtype), bands.shape[0], nodata)) as dst:
        dst.write(bands)


def load_raster(path: Path, band: int | None = 1) -> np.ndarray:
    with rasterio.open(path) as src:
        if (
            src.crs.to_epsg() != UTM_EPSG
            or src.transform != GRID.transform
            or (src.height, src.width) != GRID.shape
        ):
            raise ValueError(f"{path} is not on the analysis grid; rebuild it")
        return np.asarray(src.read(band) if band else src.read())
