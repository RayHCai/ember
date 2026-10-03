import math

import numpy as np
from ember_drone_runtime.camera import CameraSpec, hit_plane, pixel_rays
from ember_drone_runtime.geo import LatLng, LocalFrame, inside_polygon, polygon_area

LAHAINA = LatLng(20.879, -156.676)


def test_local_frame_round_trips_and_scales() -> None:
    frame = LocalFrame(LAHAINA)
    x, y = frame.point(LatLng(LAHAINA.lat + 0.01, LAHAINA.lng + 0.01))
    assert math.isclose(y, 1107.0, rel_tol=0.01)  # ~111 km per degree of latitude
    assert math.isclose(x, 1107.0 * math.cos(math.radians(LAHAINA.lat)), rel_tol=0.01)
    back = frame.latlng(x, y)
    assert math.isclose(back.lat, LAHAINA.lat + 0.01, abs_tol=1e-9)
    assert math.isclose(back.lng, LAHAINA.lng + 0.01, abs_tol=1e-9)


def test_polygon_helpers() -> None:
    square = np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]])
    inside = inside_polygon(np.array([5.0, 15.0, -1.0]), np.array([5.0, 5.0, 5.0]), square)
    assert inside.tolist() == [True, False, False]
    assert polygon_area(square) == 100.0


def test_nadir_centre_ray_hits_below_and_image_top_faces_heading() -> None:
    spec = CameraSpec(100, 80, 90.0)
    rays = pixel_rays(spec, 90.0, -90.0, np.array([50.0, 50.0]), np.array([40.0, 0.0]))
    pts, hit = hit_plane(np.array([0.0, 0.0, 100.0]), rays, 0.0, 1000.0)
    assert hit.all()
    assert np.allclose(pts[0], [0.0, 0.0, 0.0], atol=1e-9)
    # Heading east: the top edge of the image is east of the drone.
    assert pts[1][0] > 30 and abs(pts[1][1]) < 1e-9


def test_rays_above_the_horizon_are_clipped_and_flagged() -> None:
    spec = CameraSpec(100, 80, 90.0)
    rays = pixel_rays(spec, 0.0, 0.0, np.array([50.0]), np.array([0.0]))
    pts, hit = hit_plane(np.array([0.0, 0.0, 50.0]), rays, 0.0, 400.0)
    assert not hit[0]
    assert math.isclose(float(np.hypot(pts[0][0], pts[0][1])), 400.0)


def test_footprint_at_nadir() -> None:
    w, h = CameraSpec(640, 480, 90.0).footprint_m(50.0)
    assert math.isclose(w, 100.0)
    assert math.isclose(h, 75.0)
