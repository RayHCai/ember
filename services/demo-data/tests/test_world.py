"""The 3D viewer's world reconstruction: trees only where trees are, varied, and fire-aware."""

import gzip
import json

import numpy as np
import pytest
from ember_demo_data.config import DERIVED_DIR, LAYERS, ORIGIN_LAT, ORIGIN_LON
from ember_demo_data.world.frame import EXTENT, FRAME
from ember_demo_data.world.layers import BARE, BUILT_UP, GRASSLAND, ROAD_WIDTH_M, TREE_COVER, WATER
from ember_demo_data.world.vegetation import FIELDS, FORMS, canopy_mask, crowns
from scipy import ndimage

have_data = (DERIVED_DIR / "arrival.tif").exists() and all(
    layer.path.exists() for layer in LAYERS.values()
)
needs_data = pytest.mark.skipif(
    not have_data, reason="run `demo-data download` and `demo-data build` first"
)
F = {k: i for i, k in enumerate(FIELDS)}


def test_frame_round_trip():
    x, y = FRAME.to_local(-156.6772, 20.8725)
    lon, lat = FRAME.to_lonlat(x, y)
    assert abs(lon + 156.6772) < 1e-9 and abs(lat - 20.8725) < 1e-9
    _, y1 = FRAME.to_local(FRAME.lon0, FRAME.lat0 + 1000 / FRAME.m_lat)
    assert abs(y1 - 1000) < 1e-6


def _scene(landcover_code: int):
    """Yellow-green open grass with one dark, textured crown in the middle."""
    rng = np.random.default_rng(1)
    n = 80
    rgb = np.empty((n, n, 3), dtype=np.float32)
    rgb[:] = (0.46, 0.45, 0.30)
    rgb += rng.normal(0, 0.01, rgb.shape).astype(np.float32)
    yy, xx = np.mgrid[0:n, 0:n]
    crown = (yy - 40) ** 2 + (xx - 40) ** 2 <= 8**2
    shade = 0.6 + 0.8 * rng.random((n, n))  # crowns are textured: sunlit leaves and self-shadow
    rgb[crown] = np.stack([0.10 * shade, 0.24 * shade, 0.08 * shade], -1)[crown]
    landcover = np.full((n, n), landcover_code, dtype=np.uint8)
    return rgb, crown, landcover


@pytest.mark.parametrize("code", [TREE_COVER, BUILT_UP, GRASSLAND])
def test_a_crown_becomes_a_tree_where_trees_can_grow(code):
    rgb, crown, landcover = _scene(code)
    mask, lum = canopy_mask(rgb, np.ones(crown.shape, bool), landcover, np.zeros(crown.shape, bool))
    assert (mask & crown).sum() > 0.6 * crown.sum()
    # Features are smoothed at crown scale, so the canopy may spill by a pixel or two, no further.
    assert not (mask & ~ndimage.binary_dilation(crown, iterations=2)).any()
    _centres, radius = crowns(mask, lum)
    assert 1 <= len(radius) <= 3 and radius.max() > 4


@pytest.mark.parametrize("code", [WATER, BARE])
def test_no_trees_on_water_or_bare_ground(code):
    rgb, crown, landcover = _scene(code)
    mask, _ = canopy_mask(rgb, np.ones(crown.shape, bool), landcover, np.zeros(crown.shape, bool))
    assert not mask.any()


def test_no_trees_on_blocked_pixels():
    rgb, crown, landcover = _scene(TREE_COVER)
    mask, _ = canopy_mask(rgb, np.ones(crown.shape, bool), landcover, crown)
    assert not (mask & crown).any()


def test_open_grass_is_not_canopy():
    rgb, crown, landcover = _scene(GRASSLAND)
    rgb[crown] = (0.46, 0.45, 0.30)
    mask, _ = canopy_mask(rgb, np.ones(crown.shape, bool), landcover, np.zeros(crown.shape, bool))
    assert not mask.any()


@pytest.fixture(scope="module")
def world():
    from ember_demo_data.world import store

    store.build()
    d = store._dir()
    trees = np.frombuffer(gzip.decompress((d / "vegetation.bin.gz").read_bytes()), "<f4").reshape(
        -1, len(FIELDS)
    )
    buildings = json.loads(gzip.decompress((d / "buildings.json.gz").read_bytes()))["buildings"]
    return trees, buildings, gzip.decompress((d / "fire.bin.gz").read_bytes()), store.manifest()


@needs_data
def test_trees_avoid_water_buildings_and_roads(world):
    from ember_demo_data.world.layers import WATER_FUEL, ground_layers, road_mask

    trees, *_ = world
    L = ground_layers()
    x, y = trees[:, F["x"]], trees[:, F["y"]]
    assert (
        (x >= EXTENT.min_x) & (x < EXTENT.max_x) & (y >= EXTENT.min_y) & (y < EXTENT.max_y)
    ).all()
    r, c, inside = L.cells(x, y)
    assert inside.all()
    assert (L.fuel[r, c] != WATER_FUEL).all()
    assert not L.building(trees[:, F["x"]], trees[:, F["y"]]).any()
    assert not np.isin(L.worldcover[r, c], [BARE, WATER]).any()
    # Sample of trees: none stands on a named road.
    for x, y in trees[:: max(1, len(trees) // 300), :2]:
        assert not road_mask(float(x) - 0.5, float(y) + 0.5, 1, 1.0)[0, 0]


@needs_data
def test_trees_vary_in_form_height_and_colour(world):
    trees, *_ = world
    assert len(trees) > 10_000
    forms = np.bincount(trees[:, F["form"]].astype(int), minlength=len(FORMS))
    assert (forms > 0).all(), dict(zip(FORMS, forms, strict=True))
    assert trees[:, F["height_m"]].std() > 2.0
    assert trees[:, F["crown_radius_m"]].std() > 0.5
    assert (trees[:, F["r"] : F["b"] + 1].std(0) > 0.02).all()


@needs_data
def test_trees_carry_the_fire(world):
    trees, *_ = world
    burns = trees[:, F["arrival_min"]] < 1e5
    assert burns.sum() > 1000
    assert 0 < trees[burns, F["survives"]].sum() < burns.sum()


@needs_data
def test_buildings_and_fire_grid(world):
    _, buildings, fire, manifest = world
    assert len(buildings) == manifest["buildings"]["count"] == 2969
    assert sum(b["destroyed"] for b in buildings) == 2127
    assert len({round(b["height_m"]) for b in buildings}) > 5
    g = manifest["fire"]
    n = g["width"] * g["height"]
    assert len(fire) == n * 17
    cells = np.frombuffer(fire[: n * 16], "<f4").reshape(g["height"], g["width"], 4)
    # Rows run south to north: the cell holding the rekindle origin matches the model grid there.
    from ember_demo_data.world.layers import ground_layers

    x, y = FRAME.to_local(ORIGIN_LON, ORIGIN_LAT)
    col = int((x - EXTENT.min_x) // g["cell_m"])
    row = int((y - EXTENT.min_y) // g["cell_m"])
    cx = EXTENT.min_x + (col + 0.5) * g["cell_m"]
    cy = EXTENT.min_y + (row + 0.5) * g["cell_m"]
    L = ground_layers()
    r, c, _ = L.cells(np.array([cx]), np.array([cy]))
    assert cells[row, col, 0] == pytest.approx(float(L.arrival[r[0], c[0]]))
    assert -510 < cells[row - 2 : row + 3, col - 2 : col + 3, 0].min() < -480, (
        "morning fire burned here at 06:34"
    )


@needs_data
def test_world_api(world):
    from ember_demo_data.api.app import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    m = client.get("/v1/world").json()
    assert m["frame"]["origin"] == {"lat": FRAME.lat0, "lon": FRAME.lon0}
    veg = client.get(m["vegetation"]["url"])
    assert len(veg.content) == m["vegetation"]["count"] * len(FIELDS) * 4
    roads = client.get(m["roads"]["url"]).json()["roads"]
    assert len(roads) == m["roads"]["count"] > 100
    assert all(r["width_m"] in ROAD_WIDTH_M.values() and len(r["points"]) >= 2 for r in roads)
    patch = client.get(
        m["imagery"]["layers"]["pre"]["patch_url"], params={"x": -1300, "y": -300, "size_m": 256}
    )
    assert patch.status_code == 200 and patch.headers["content-type"] == "image/jpeg"
    assert patch.headers["x-ember-extent"] == "-1408.0,-448.0,-1152.0,-192.0"
    assert client.get("/v1/world/imagery/nope.jpg").status_code == 404
