"""Coordinate math. Every function takes and returns (lon, lat) in WGS84 degrees unless noted.

Web Mercator tile math follows the XYZ ("slippy map") scheme: x grows east, y grows
south, tile (0, 0) at zoom 0 covers the world. MBTiles files store rows in the TMS
scheme (y grows north); the conversion lives in tiles.py and nowhere else.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
from pyproj import CRS, Geod, Transformer

from .config import AOI, UTM_EPSG, BBox

TILE_SIZE = 256
EARTH_CIRCUMFERENCE_M = 2 * math.pi * 6378137.0
MAX_MERCATOR_LAT = 85.05112878


class LocationError(ValueError):
    """A requested position is invalid or outside the data coverage."""


# --- Web Mercator ----------------------------------------------------------------------------


def lonlat_to_global_px(lon, lat, z: int):
    """Fractional global pixel coordinates at zoom z (pixel edges at integers)."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.clip(np.asarray(lat, dtype=np.float64), -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
    world = TILE_SIZE * (2**z)
    px = (lon + 180.0) / 360.0 * world
    lat_r = np.radians(lat)
    py = (1.0 - np.arcsinh(np.tan(lat_r)) / math.pi) / 2.0 * world
    return px, py


def global_px_to_lonlat(px, py, z: int):
    world = TILE_SIZE * (2**z)
    px = np.asarray(px, dtype=np.float64)
    py = np.asarray(py, dtype=np.float64)
    lon = px / world * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * py / world))))
    return lon, lat


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    px, py = lonlat_to_global_px(lon, lat, z)
    return int(px // TILE_SIZE), int(py // TILE_SIZE)


def tile_bounds(z: int, x: int, y: int) -> BBox:
    west, north = global_px_to_lonlat(x * TILE_SIZE, y * TILE_SIZE, z)
    east, south = global_px_to_lonlat((x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE, z)
    return BBox(float(west), float(south), float(east), float(north))


def tiles_for_bbox(bbox: BBox, z: int) -> list[tuple[int, int]]:
    x0, y0 = lonlat_to_tile(bbox.west, bbox.north, z)
    x1, y1 = lonlat_to_tile(bbox.east, bbox.south, z)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def ground_resolution_m(lat: float, z: int) -> float:
    """Ground size of one Web Mercator pixel at zoom z, in metres."""
    return EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat)) / (TILE_SIZE * 2**z)


def zoom_for_resolution(lat: float, metres_per_px: float, max_zoom: int, min_zoom: int = 0) -> int:
    """Coarsest zoom whose pixels are at least as fine as metres_per_px, clamped."""
    z = math.ceil(math.log2(EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat)) / (TILE_SIZE * max(metres_per_px, 1e-3))))
    return int(min(max(z, min_zoom), max_zoom))


# --- Projected frames -------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _utm_transformers() -> tuple[Transformer, Transformer]:
    fwd = Transformer.from_crs(4326, UTM_EPSG, always_xy=True)
    inv = Transformer.from_crs(UTM_EPSG, 4326, always_xy=True)
    return fwd, inv


def to_utm(lon, lat):
    fwd, _ = _utm_transformers()
    return fwd.transform(lon, lat)


def from_utm(easting, northing):
    _, inv = _utm_transformers()
    return inv.transform(easting, northing)


class LocalFrame:
    """Exact local east/north frame (azimuthal equidistant) centred on a point.

    Distances and bearings measured from the centre are true geodesic values, so a
    camera ray that hits the ground 300 m east of the drone maps to the point that is
    really 300 m east, not an approximation of it.
    """

    def __init__(self, lon0: float, lat0: float):
        self.lon0, self.lat0 = lon0, lat0
        crs = CRS.from_proj4(f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +datum=WGS84 +units=m +no_defs")
        self._to_ll = Transformer.from_crs(crs, 4326, always_xy=True)
        self._from_ll = Transformer.from_crs(4326, crs, always_xy=True)

    def to_lonlat(self, east, north):
        return self._to_ll.transform(east, north)

    def from_lonlat(self, lon, lat):
        return self._from_ll.transform(lon, lat)

    def to_utm(self, east, north):
        lon, lat = self._to_ll.transform(east, north)
        return to_utm(lon, lat)


class FittedTransform:
    """A smooth 2-D transform approximated by a cubic polynomial over a bounded extent.

    Fitted to exact transform values on a 9x9 grid and checked on the 8x8 grid of cell
    centres; if the check residual exceeds `tol` (output units) every call falls back to
    the exact transform. Over the few-kilometre extents a drone camera sees, the residual
    is far below a millimetre, and evaluation is ~50x faster than pyproj per point.
    """

    def __init__(self, exact, x_range: tuple[float, float], y_range: tuple[float, float], tol: float):
        self.exact = exact
        x0, x1 = x_range
        y0, y1 = y_range
        if x1 - x0 < 1e-6:
            x0, x1 = x0 - 1.0, x1 + 1.0
        if y1 - y0 < 1e-6:
            y0, y1 = y0 - 1.0, y1 + 1.0
        self._c = ((x0 + x1) / 2, (y0 + y1) / 2)
        self._h = ((x1 - x0) / 2, (y1 - y0) / 2)
        gx, gy = np.meshgrid(np.linspace(x0, x1, 9), np.linspace(y0, y1, 9))
        u, v = exact(gx.ravel(), gy.ravel())
        A = self._design(gx.ravel(), gy.ravel())
        self._cu = np.linalg.lstsq(A, np.asarray(u, dtype=np.float64), rcond=None)[0]
        self._cv = np.linalg.lstsq(A, np.asarray(v, dtype=np.float64), rcond=None)[0]
        mid = np.linspace(x0, x1, 17)[1::2], np.linspace(y0, y1, 17)[1::2]
        cx, cy = np.meshgrid(*mid)
        eu, ev = exact(cx.ravel(), cy.ravel())
        fu, fv = self._eval(cx.ravel(), cy.ravel())
        self.residual = float(max(np.max(np.abs(fu - eu)), np.max(np.abs(fv - ev))))
        self.use_exact = not (self.residual <= tol)

    def _design(self, x, y):
        a = (np.asarray(x, dtype=np.float64) - self._c[0]) / self._h[0]
        b = (np.asarray(y, dtype=np.float64) - self._c[1]) / self._h[1]
        return np.stack([np.ones_like(a), a, b, a * a, a * b, b * b, a**3, a * a * b, a * b * b, b**3], axis=-1)

    def _eval(self, x, y):
        a = (np.asarray(x, dtype=np.float64) - self._c[0]) / self._h[0]
        b = (np.asarray(y, dtype=np.float64) - self._c[1]) / self._h[1]
        aa, bb, ab = a * a, b * b, a * b

        def poly(c):
            return c[0] + c[1] * a + c[2] * b + c[3] * aa + c[4] * ab + c[5] * bb + (c[6] * a + c[7] * b) * aa + (c[8] * a + c[9] * b) * bb

        return poly(self._cu), poly(self._cv)

    def __call__(self, x, y):
        if self.use_exact:
            u, v = self.exact(x, y)
            return np.asarray(u), np.asarray(v)
        return self._eval(x, y)


_GEOD = Geod(ellps="WGS84")


def geodesic_m(lon1, lat1, lon2, lat2):
    """Exact distance on the WGS84 ellipsoid, in metres (vectorised)."""
    lon1, lat1, lon2, lat2 = np.broadcast_arrays(*(np.asarray(v, dtype=np.float64) for v in (lon1, lat1, lon2, lat2)))
    _, _, d = _GEOD.inv(lon1, lat1, lon2, lat2)
    return d


# --- Validation -------------------------------------------------------------------------------


def validate_position(lat: float, lon: float, bbox: BBox = AOI) -> None:
    """Reject positions outside the data coverage instead of serving data for elsewhere.

    The error message names the likely mistake (swapped lat/lon, missing minus sign) so
    a client bug does not silently turn into imagery of the wrong place.
    """
    for name, value in (("lat", lat), ("lon", lon)):
        if value is None or not math.isfinite(value):
            raise LocationError(f"{name} must be a finite number, got {value!r}")
    if not -90 <= lat <= 90:
        hint = " It looks like lat and lon are swapped." if bbox.contains(lat, lon) else ""
        raise LocationError(f"lat {lat} is outside [-90, 90].{hint}")
    if not -180 <= lon <= 180:
        raise LocationError(f"lon {lon} is outside [-180, 180].")
    if bbox.contains(lon, lat):
        return
    covered = f"lat {bbox.south}..{bbox.north}, lon {bbox.west}..{bbox.east} (Lahaina, Maui)"
    if bbox.contains(lat, lon):
        hint = " It looks like lat and lon are swapped."
    elif bbox.contains(-lon, lat):
        hint = " Lahaina longitudes are negative (western hemisphere); the sign looks flipped."
    else:
        dist_km = float(geodesic_m(lon, lat, (bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2)) / 1000
        hint = f" The position is {dist_km:,.1f} km from Lahaina."
    raise LocationError(f"Position lat={lat}, lon={lon} is outside the demo coverage area ({covered}).{hint}")
