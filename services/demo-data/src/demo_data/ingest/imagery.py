"""Download imagery tiles for the AOI into one MBTiles file per layer."""

from __future__ import annotations

import io
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
import numpy as np
from PIL import Image

from ..config import AOI, USER_AGENT, Layer
from ..geo import tiles_for_bbox
from ..tiles import TileStore

log = logging.getLogger(__name__)


def _fetch(client: httpx.Client, layer: Layer, z: int, x: int, y: int) -> tuple[int, bytes | None]:
    url = layer.url.format(z=z, x=x, y=y)
    for attempt in range(4):
        try:
            r = client.get(url, follow_redirects=not layer.redirect_is_missing)
        except httpx.TransportError:
            time.sleep(1.5 * (attempt + 1))
            continue
        if r.status_code == 200:
            data = r.content
            try:
                img = Image.open(io.BytesIO(data))
                img.load()
            except Exception:
                return -1, None  # not an image (error page)
            if img.mode in ("RGBA", "LA", "P"):
                alpha = np.asarray(img.convert("RGBA"))[:, :, 3]
                if not alpha.any():
                    return 204, None  # fully transparent: no coverage
            return 200, data
        if r.status_code in (301, 302, 303, 307, 308) and layer.redirect_is_missing:
            return r.status_code, None
        if r.status_code == 404:
            return 404, None
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(2.0 * (attempt + 1))
            continue
        return r.status_code, None
    return -2, None


def download_layer(layer: Layer, workers: int = 8, max_zoom: int | None = None) -> dict[int, int]:
    store = TileStore(layer.path, writable=True)
    store.set_metadata(
        {
            "name": layer.id,
            "description": layer.title,
            "format": "jpg/png",
            "type": "overlay",
            "scheme": "tms",
            "bounds": ",".join(f"{v:.6f}" for v in layer.bounds.intersect(AOI).as_list()),
            "minzoom": str(layer.min_zoom),
            "maxzoom": str(min(layer.max_zoom, max_zoom or layer.max_zoom)),
            "attribution": layer.attribution,
            "captured": layer.captured.isoformat(),
            "capture_note": layer.capture_note,
            "resolution": layer.resolution,
            "license": layer.license,
            "source_url": layer.url,
        }
    )
    area = layer.bounds.intersect(AOI)
    top = min(layer.max_zoom, max_zoom or layer.max_zoom)
    stats: dict[int, int] = {}
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30.0, http2=False) as client:
        for z in range(layer.min_zoom, top + 1):
            wanted = tiles_for_bbox(area, z)
            done = store.known(z)
            todo = [t for t in wanted if t not in done]
            log.info("%s z%d: %d tiles (%d cached)", layer.id, z, len(wanted), len(wanted) - len(todo))
            got = 0
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(_fetch, client, layer, z, x, y): (x, y) for x, y in todo}
                for i, fut in enumerate(as_completed(futures), 1):
                    x, y = futures[fut]
                    status, data = fut.result()
                    if data is not None:
                        store.put(z, x, y, data)
                        got += 1
                    elif status > 0:
                        store.mark_missing(z, x, y, status)
                    if i % 500 == 0:
                        store.commit()
                        log.info("%s z%d: %d/%d", layer.id, z, i, len(todo))
            store.commit()
            stats[z] = got
    store.close()
    return stats
