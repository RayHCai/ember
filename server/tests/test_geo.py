import pytest

from app.geo.core import haversine_m, is_simple_polygon, point_in_polygon, polygon_area_km2, simplify
from app.geo.grid import ZoneGrid

# About 4 km x 4 km at 34 N.
SQUARE = [(34.18, -118.08), (34.18, -118.0365), (34.216, -118.0365), (34.216, -118.08)]


def test_point_in_polygon() -> None:
    assert point_in_polygon((34.2, -118.06), SQUARE)
    assert not point_in_polygon((34.25, -118.06), SQUARE)
    assert not point_in_polygon((34.2, -118.0), SQUARE)


def test_area_of_square() -> None:
    assert polygon_area_km2(SQUARE) == pytest.approx(16.0, rel=0.02)


def test_haversine_one_degree_of_latitude() -> None:
    assert haversine_m((34.0, -118.0), (35.0, -118.0)) == pytest.approx(111_195, rel=0.001)


def test_self_crossing_polygon_is_detected() -> None:
    bowtie = [(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.0, 1.0)]
    assert not is_simple_polygon(bowtie)
    assert is_simple_polygon(SQUARE)


def test_simplify_drops_collinear_points() -> None:
    line = [(34.0, -118.0 + i * 0.001) for i in range(20)]
    assert simplify(line, 5) == [line[0], line[-1]]


def test_grid_cells_are_about_100_m_and_mask_the_polygon() -> None:
    grid = ZoneGrid.from_polygon(SQUARE, 100)
    assert 39 <= grid.rows <= 42 and 39 <= grid.cols <= 42
    inside = grid.zone_cells()
    # Most of the bounding box is the square itself.
    assert len(inside) / grid.size > 0.9
    a, b = grid.center(0), grid.center(1)
    assert haversine_m(a, b) == pytest.approx(100, rel=0.02)
    assert grid.cell_at(grid.center(57)) == 57


def test_triangle_masks_out_cells() -> None:
    triangle = [(34.18, -118.08), (34.18, -118.0365), (34.216, -118.08)]
    grid = ZoneGrid.from_polygon(triangle, 100)
    share = len(grid.zone_cells()) / grid.size
    assert 0.4 < share < 0.6
    payload = grid.to_payload()
    assert len(payload["in_zone"]) == grid.size
