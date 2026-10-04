"""MBTiles storage and georeferenced sampling of cached imagery.

The public API speaks XYZ tile coordinates only. MBTiles (spec 1.3) stores rows in the
TMS scheme, so `_tms_row` is the single place where y is flipped.
"""

from __future__ import annotations

import io
import json
import sqlite3
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image

from .config import DERIVED_DIR, LAYERS, Layer
from .geo import TILE_SIZE, lonlat_to_global_px, zoom_for_resolution
from .render.sampling import Bilinear


def _tms_row(z: int, y: int) -> int:
    return (1 << z) - 1 - y


class TileStore:
    """One MBTiles file per imagery layer."""

    def __init__(self, path: Path, writable: bool = False):
        self.path = Path(path)
        if writable:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE IF NOT EXISTS tiles (
                    zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
                    PRIMARY KEY (zoom_level, tile_column, tile_row));
                CREATE TABLE IF NOT EXISTS missing (
                    zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, status INTEGER,
                    PRIMARY KEY (zoom_level, tile_column, tile_row));
                """
            )
        else:
            if not self.path.exists():
                raise FileNotFoundError(f"{self.path} not found; run `demo-data download` first")
            self._conn = sqlite3.connect(
                f"file:{self.path.as_posix()}?mode=ro", uri=True, check_same_thread=False
            )
        self._lock = threading.Lock()

    def close(self) -> None:
        self._conn.close()

    def set_metadata(self, values: dict[str, str]) -> None:
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO metadata VALUES (?, ?)", list(values.items())
            )
            self._conn.commit()

    def metadata(self) -> dict[str, str]:
        with self._lock:
            return dict(self._conn.execute("SELECT name, value FROM metadata").fetchall())

    def put(self, z: int, x: int, y: int, data: bytes) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)", (z, x, _tms_row(z, y), data)
            )

    def mark_missing(self, z: int, x: int, y: int, status: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO missing VALUES (?, ?, ?, ?)", (z, x, _tms_row(z, y), status)
            )

    def commit(self) -> None:
        with self._lock:
            self._conn.commit()

    def get(self, z: int, x: int, y: int) -> bytes | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, _tms_row(z, y)),
            ).fetchone()
        return row[0] if row else None

    def known(self, z: int) -> set[tuple[int, int]]:
        """XYZ tiles at zoom z that are stored or known to be missing upstream."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT tile_column, tile_row FROM tiles WHERE zoom_level=? "
                "UNION SELECT tile_column, tile_row FROM missing WHERE zoom_level=?",
                (z, z),
            ).fetchall()
        return {(x, _tms_row(z, r)) for x, r in rows}

    def count(self) -> dict[int, int]:
        with self._lock:
            return dict(
                self._conn.execute(
                    "SELECT zoom_level, COUNT(*) FROM tiles GROUP BY zoom_level"
                ).fetchall()
            )


class ImagerySampler:
    """Samples RGB imagery from a layer at arbitrary lon/lat points."""

    def __init__(self, layer: Layer, cache_tiles: int = 1024):
        self.layer = layer
        self.store = TileStore(layer.path)
        # Measured misregistration of this layer (see verify.coregister): a feature at true
        # position P appears in the imagery at P + displacement, so reads are offset by it.
        self.displacement = (0.0, 0.0)
        coreg = DERIVED_DIR / "coregistration.json"
        if coreg.exists():
            d = json.loads(coreg.read_text()).get("layers", {}).get(layer.id)
            if d:
                self.displacement = (d["displacement_east_m"], d["displacement_north_m"])
        self._cache: OrderedDict[tuple[int, int, int], np.ndarray | None] = OrderedDict()
        self._cache_size = cache_tiles
        self._lock = threading.Lock()

    def _tile(self, z: int, x: int, y: int) -> np.ndarray | None:
        key = (z, x, y)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        data = self.store.get(z, x, y)
        arr = None
        if data is not None:
            # RGBA so that transparent edge-of-coverage pixels count as "no data", not black.
            arr = np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"), dtype=np.uint8)
        with self._lock:
            self._cache[key] = arr
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return arr

    def sample(
        self, lon: np.ndarray, lat: np.ndarray, metres_per_px: float, max_tiles: int = 144
    ) -> tuple[np.ndarray, np.ndarray]:
        """Bilinear RGB samples (float32, 0..1) and a validity mask for each point.

        Zoom is chosen to match metres_per_px; if the points span more than max_tiles
        tiles (a far-reaching oblique view) the zoom is lowered until they fit.
        """
        lon = np.asarray(lon, dtype=np.float64)
        lat = np.asarray(lat, dtype=np.float64)
        de, dn = self.displacement
        if de or dn:
            lat = lat + dn / 111_320.0
            lon = lon + de / (111_320.0 * np.cos(np.radians(lat)))
        out = np.zeros((*lon.shape, 3), dtype=np.float32)
        valid = np.zeros(lon.shape, dtype=bool)
        finite = np.isfinite(lon) & np.isfinite(lat)
        if not finite.any():
            return out, valid
        lat_ref = float(np.nanmedian(lat[finite]))
        z = zoom_for_resolution(lat_ref, metres_per_px, self.layer.max_zoom, self.layer.min_zoom)
        while True:
            px, py = lonlat_to_global_px(lon[finite], lat[finite], z)
            tx0, tx1 = int(np.floor(px.min() / TILE_SIZE)), int(np.floor(px.max() / TILE_SIZE))
            ty0, ty1 = int(np.floor(py.min() / TILE_SIZE)), int(np.floor(py.max() / TILE_SIZE))
            if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= max_tiles or z <= self.layer.min_zoom:
                break
            z -= 1
        nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
        mosaic = np.zeros(
            (ny * TILE_SIZE, nx * TILE_SIZE, 4), dtype=np.uint8
        )  # RGBA; A=0 means no data
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                arr = self._tile(z, tx, ty)
                if arr is None:
                    continue
                r0, c0 = (ty - ty0) * TILE_SIZE, (tx - tx0) * TILE_SIZE
                mosaic[r0 : r0 + TILE_SIZE, c0 : c0 + TILE_SIZE] = arr
        # Pixel centres sit at +0.5, so subtract it to convert edges to array indices.
        cols = px - tx0 * TILE_SIZE - 0.5
        rows = py - ty0 * TILE_SIZE - 0.5
        samples = Bilinear(rows, cols, mosaic.shape[:2])(mosaic)  # 8-bit bilinear
        out[finite] = samples[:, :3] / 255.0
        valid[finite] = samples[:, 3] > 0.99 * 255
        return out, valid


_samplers: dict[str, ImagerySampler] = {}
_samplers_lock = threading.Lock()


def reset_samplers() -> None:
    with _samplers_lock:
        _samplers.clear()


def sampler(layer_id: str) -> ImagerySampler:
    with _samplers_lock:
        if layer_id not in _samplers:
            _samplers[layer_id] = ImagerySampler(LAYERS[layer_id])
        return _samplers[layer_id]
