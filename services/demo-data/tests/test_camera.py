import math

import numpy as np
import pytest

from demo_data.geo import LocalFrame, geodesic_m
from demo_data.render.camera import Camera, Pose, cast, footprint, ground_point


def test_nadir_footprint_size():
    pose = Pose(20.8725, -156.6772, alt_m=150.0, heading_deg=0.0, pitch_deg=-90.0)
    cam = Camera(640, 480, 84.0)
    hits = cast(pose, cam)
    width = np.nanmax(hits.east) - np.nanmin(hits.east)
    expected = 2 * 150.0 * math.tan(math.radians(42.0)) * (639 / 640)  # pixel centres
    assert width == pytest.approx(expected, rel=1e-6)
    assert hits.gsd_m == pytest.approx(2 * 150.0 * math.tan(math.radians(42.0)) / 640, rel=1e-3)


def test_nadir_centre_is_below_the_drone():
    pose = Pose(20.8725, -156.6772, alt_m=200.0, heading_deg=33.0, pitch_deg=-90.0)
    lon, lat = ground_point(pose, 320.5, 240.5, Camera(641, 481))
    assert geodesic_m(pose.lon, pose.lat, lon, lat) < 1e-6


@pytest.mark.parametrize(
    "heading,east_sign,north_sign", [(0, 0, 1), (90, 1, 0), (180, 0, -1), (270, -1, 0)]
)
def test_image_top_points_along_heading(heading, east_sign, north_sign):
    pose = Pose(20.8725, -156.6772, alt_m=100.0, heading_deg=heading, pitch_deg=-90.0)
    cam = Camera(101, 101, 60.0)
    hits = cast(pose, cam)
    top_e, top_n = hits.east[0, 50], hits.north[0, 50]
    assert np.sign(round(top_e, 6)) == east_sign
    assert np.sign(round(top_n, 6)) == north_sign


def test_oblique_centre_distance():
    # Looking 30 deg below the horizon from 150 m, the centre ray lands 150/tan(30) away.
    pose = Pose(20.8790, -156.6760, alt_m=150.0, heading_deg=90.0, pitch_deg=-30.0)
    lon, lat = ground_point(pose, 320.5, 240.5, Camera(641, 481))
    frame = LocalFrame(pose.lon, pose.lat)
    e, n = frame.from_lonlat(lon, lat)
    assert e == pytest.approx(150.0 / math.tan(math.radians(30.0)), rel=1e-9)
    assert n == pytest.approx(0.0, abs=1e-6)


def test_horizon_pixels_are_sky():
    pose = Pose(20.8790, -156.6760, alt_m=100.0, heading_deg=0.0, pitch_deg=0.0)
    hits = cast(pose, Camera(64, 48, 84.0))
    assert not hits.ground[:24].any()  # upper half looks above the horizon
    assert hits.ground[30:].all()


def test_footprint_is_closed_ring_around_centre():
    pose = Pose(20.8725, -156.6772, alt_m=150.0)
    fp = footprint(pose, Camera())
    lons = [p[0] for p in fp]
    lats = [p[1] for p in fp]
    assert min(lons) < pose.lon < max(lons) and min(lats) < pose.lat < max(lats)


def test_pose_validation():
    with pytest.raises(ValueError):
        Pose(20.87, -156.67, alt_m=0.0).validated()
    with pytest.raises(ValueError):
        Pose(20.87, -156.67, pitch_deg=-120).validated()
