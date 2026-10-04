"""World assets for the 3D drone viewer (see world/): built on first request, then cached."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from ..world import imagery, store

router = APIRouter(prefix="/v1/world", tags=["world"])
CACHE = {"Cache-Control": "public, max-age=3600"}


def _gzipped(name: str, media_type: str) -> Response:
    # Stored gzip-compressed; browsers decompress transparently.
    return Response(
        store.asset(name), media_type=media_type, headers={**CACHE, "Content-Encoding": "gzip"}
    )


@router.get("")
def get_world() -> dict[str, Any]:
    """Manifest: frame definition, extent, scenario timing and where each asset lives."""
    return store.manifest()


@router.get("/vegetation.bin")
def get_vegetation() -> Response:
    return _gzipped("vegetation.bin.gz", "application/octet-stream")


@router.get("/buildings.json")
def get_buildings() -> Response:
    return _gzipped("buildings.json.gz", "application/json")


@router.get("/roads.json")
def get_roads() -> Response:
    return _gzipped("roads.json.gz", "application/json")


@router.get("/fire.bin")
def get_fire() -> Response:
    return _gzipped("fire.bin.gz", "application/octet-stream")


@router.get("/imagery/{kind}.jpg")
def get_mosaic(kind: str) -> Response:
    if kind not in imagery.CHAINS:
        raise HTTPException(404, f"imagery kind must be one of {sorted(imagery.CHAINS)}")
    return Response(store.asset(f"imagery_{kind}.jpg"), media_type="image/jpeg", headers=CACHE)


@router.get("/imagery/{kind}/patch.jpg")
def get_patch(
    kind: str,
    x: float = Query(..., description="world-frame metres east of the origin"),
    y: float = Query(..., description="world-frame metres north of the origin"),
    size_m: float = 512.0,
    res_m: float = 0.5,
) -> Response:
    """A sharper square of ground imagery near (x, y). Its exact extent is in X-Ember-Extent."""
    data, extent = imagery.patch(kind, x, y, size_m, res_m)
    header = ",".join(str(round(extent[k], 3)) for k in ("min_x", "min_y", "max_x", "max_y"))
    return Response(data, media_type="image/jpeg", headers={**CACHE, "X-Ember-Extent": header})
