import math

import numpy as np
import pytest
from ember_demo_data.config import AOI
from ember_demo_data.geo import (
    FittedTransform,
    LocalFrame,
    LocationError,
    from_utm,
    geodesic_m,
    global_px_to_lonlat,
    ground_resolution_m,
    lonlat_to_global_px,
    lonlat_to_tile,
    tile_bounds,
    to_utm,
    validate_position,
)
from ember_demo_data.tiles import _tms_row


def test_known_tiles():
    # Null Island sits on the corner of the four zoom-1 tiles.
    assert lonlat_to_tile(0.0001, -0.0001, 1) == (1, 1)
    assert lonlat_to_tile(-0.0001, 0.0001, 1) == (0, 0)
    # The tile we fetched by hand for Front St, Lahaina (z18 x16979 y115520).
    assert lonlat_to_tile(-156.6825, 20.8783, 18) == (16979, 115520)


def test_tile_bounds_contain_point():
    lon, lat = -156.6772, 20.8725
    for z in range(10, 21):
        x, y = lonlat_to_tile(lon, lat, z)
        b = tile_bounds(z, x, y)
        assert b.west <= lon <= b.east and b.south <= lat <= b.north


def test_global_px_round_trip():
    lon = np.array([-156.695, -156.6772, -156.64])
    lat = np.array([20.838, 20.8725, 20.915])
    px, py = lonlat_to_global_px(lon, lat, 19)
    lon2, lat2 = global_px_to_lonlat(px, py, 19)
    assert np.allclose(lon, lon2, atol=1e-10) and np.allclose(lat, lat2, atol=1e-10)


def test_mbtiles_row_flip_is_an_involution():
    for z in (0, 5, 18):
        for y in (0, 1, 2**z - 1):
            assert _tms_row(z, _tms_row(z, y)) == y
    assert _tms_row(1, 0) == 1


def test_ground_resolution():
    # z19 at Lahaina is ~0.28 m per pixel.
    assert ground_resolution_m(20.88, 19) == pytest.approx(0.2789, abs=1e-3)


def test_local_frame_is_exact():
    frame = LocalFrame(-156.6772, 20.8725)
    lon, lat = frame.to_lonlat(np.array([300.0, 0.0, -1500.0]), np.array([0.0, 400.0, 2000.0]))
    d = geodesic_m(-156.6772, 20.8725, np.asarray(lon), np.asarray(lat))
    assert d == pytest.approx([300.0, 400.0, 2500.0], abs=1e-6)
    e, n = frame.from_lonlat(lon, lat)
    assert np.allclose(e, [300.0, 0.0, -1500.0], atol=1e-6) and np.allclose(
        n, [0.0, 400.0, 2000.0], atol=1e-6
    )


def test_fitted_transform_matches_exact():
    frame = LocalFrame(-156.67, 20.88)
    ft = FittedTransform(frame.to_lonlat, (-4000, 4000), (-4000, 4000), tol=1e-8)
    assert not ft.use_exact
    rng = np.random.default_rng(1)
    e, n = rng.uniform(-4000, 4000, 1000), rng.uniform(-4000, 4000, 1000)
    lon, lat = ft(e, n)
    lon2, lat2 = frame.to_lonlat(e, n)
    assert np.max(geodesic_m(lon, lat, np.asarray(lon2), np.asarray(lat2))) < 1e-3


def test_utm_round_trip():
    e, n = to_utm(-156.6772, 20.8725)
    lon, lat = from_utm(e, n)
    assert lon == pytest.approx(-156.6772, abs=1e-9) and lat == pytest.approx(20.8725, abs=1e-9)


def test_validate_accepts_lahaina():
    validate_position(20.8725, -156.6772)


@pytest.mark.parametrize(
    "lat,lon,hint",
    [
        (-156.6772, 20.8725, "swapped"),
        (20.8725, 156.6772, "negative"),
        (21.3069, -157.8583, "km from Lahaina"),
        (float("nan"), -156.6772, "finite"),
    ],
)
def test_validate_rejects_with_hint(lat, lon, hint):
    with pytest.raises(LocationError, match=hint):
        validate_position(lat, lon)


def test_aoi_covers_official_perimeter():
    # WFIGS Lahaina perimeter bounds.
    assert AOI.west < -156.68777 and AOI.east > -156.64711
    assert AOI.south < 20.84434 and AOI.north > 20.90855
    assert math.isclose(AOI.west, -156.695)
