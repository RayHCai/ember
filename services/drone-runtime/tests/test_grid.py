import math

import numpy as np
from ember_drone_runtime.link.messages import PeerCoverage
from ember_drone_runtime.mapping.grid import MissionGrid
from ember_drone_runtime.swarm.goals import TilePlan


def test_layout_matches_the_contract() -> None:
    grid = MissionGrid(radius_m=95.0, cell_m=10.0, margin_m=0.0)
    assert grid.cols == math.ceil(2 * 95 / 10)
    corner = -grid.cols * 10 / 2
    row, col, ok = grid.cells(
        np.array([corner + 1, corner + 21]), np.array([corner + 1, corner + 11])
    )
    assert ok.all()
    # Row 0 is the south edge, col 0 the west edge, index row * cols + col.
    assert (row * grid.cols + col).tolist() == [0, grid.cols + 2]


def test_coverage_is_shared_once_and_not_echoed() -> None:
    grid = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    xs = np.linspace(-40, 40, 9)
    grid.observe(xs, np.zeros_like(xs), None)
    assert grid.coverage() > 0
    fresh = grid.take_fresh()
    assert fresh is not None and len(fresh.cells) == 9 and set(fresh.top_m) == {None}
    grid.observe(xs, np.zeros_like(xs), None)
    assert grid.take_fresh() is None
    other = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    other.merge(fresh)
    other.observe(xs, np.zeros_like(xs), None)
    assert other.take_fresh() is None
    assert other.coverage() == grid.coverage()


def test_heights_use_ground_seen_nearby_under_canopy() -> None:
    grid = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    # Canopy top at 25 m over one cell; the forest floor only visible in the next cell.
    grid.observe(np.array([5.0]), np.array([5.0]), np.array([25.0]))
    grid.observe(np.array([15.0]), np.array([5.0]), np.array([0.0]))
    row, col, _ = grid.cells(np.array([5.0]), np.array([5.0]))
    assert grid.heights()[row[0], col[0]] == 25.0
    assert grid.ground_at(5.0, 5.0) == 0.0
    fresh = grid.take_fresh()
    assert fresh is not None and 25.0 in fresh.top_m


def test_peer_heights_merge() -> None:
    grid = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    grid.merge(PeerCoverage((0, 5), (None, 18.0)))
    assert grid.observed.flat[0] and grid.observed.flat[5]
    assert grid.heights().flat[5] == 18.0


def test_boundary_limits_what_must_be_mapped() -> None:
    half = np.array([[-200.0, -200.0], [0.0, -200.0], [0.0, 200.0], [-200.0, 200.0]])
    full = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    west = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0, boundary_xy=half)
    assert abs(west.target_count - full.target_count / 2) <= full.cols
    xs, ys = west.cx[west.target], west.cy[west.target]
    west.observe(xs, ys, None)
    assert west.coverage() == 1.0
    assert TilePlan(west, 50.0).open_tiles() == []


def test_risk_marks_cells_under_an_outline() -> None:
    grid = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    outline = np.array([[0.0, 0.0], [30.0, 0.0], [30.0, 30.0], [0.0, 30.0]])
    assert grid.cells_under(outline).size == 9
    grid.mark_risk(grid.cells_under(outline), "at_risk")
    grid.mark_risk(grid.cells_under(outline * 0.3), "on_fire")
    row, col, _ = grid.cells(np.array([5.0, 25.0]), np.array([5.0, 25.0]))
    assert grid.risk[row, col].tolist() == [2, 1]


def test_outline_past_the_grid_edge_keeps_its_cells_inside() -> None:
    grid = MissionGrid(radius_m=100.0, cell_m=10.0, margin_m=0.0)
    outline = np.array([[80.0, 80.0], [500.0, 80.0], [500.0, 500.0], [80.0, 500.0]])
    assert grid.cells_under(outline).size == 4
    assert grid.cells_under(outline + 1000.0).size == 0
