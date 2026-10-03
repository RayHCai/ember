import numpy as np
from ember_drone_runtime.mapping.grid import MissionGrid
from ember_drone_runtime.nav.avoid import avoid, contain
from ember_drone_runtime.nav.path import Terrain, line_clear, plan
from ember_drone_runtime.swarm.goals import Agent, GoalTile, TilePlan, assign


def test_head_on_drones_pass_each_other() -> None:
    pos = [np.array([-100.0, 0.0, 60.0]), np.array([100.0, 0.0, 60.0])]
    vel = [np.zeros(3), np.zeros(3)]
    want = [np.array([8.0, 0.0, 0.0]), np.array([-8.0, 0.0, 0.0])]
    closest = np.inf
    for _ in range(400):
        new = [avoid(pos[i], want[i], [(pos[1 - i], vel[1 - i])], 15.0, 6.0, 10.0) for i in (0, 1)]
        vel = new
        pos = [pos[i] + vel[i] * 0.1 for i in (0, 1)]
        closest = min(closest, float(np.linalg.norm(pos[0] - pos[1])))
    assert closest > 10.0
    assert pos[0][0] > 50 and pos[1][0] < -50  # and both still got where they were going


def test_geofence_removes_outward_motion_and_pulls_back_in() -> None:
    edge = contain(np.array([95.0, 0.0, 60.0]), np.array([5.0, 5.0, 0.0]), 100.0, 2.0, 10.0)
    assert edge[0] == 0.0 and edge[1] == 5.0
    outside = contain(np.array([120.0, 0.0, 60.0]), np.zeros(3), 100.0, 2.0, 10.0)
    assert outside[0] < 0


def wall_grid() -> tuple[MissionGrid, np.ndarray]:
    grid = MissionGrid(radius_m=200.0, cell_m=10.0, margin_m=0.0)
    # A ridge of 150 m towers along x = 0 from the north edge of the disc down to y = -60.
    ys = np.arange(-55.0, 200.0, 5.0)
    xs = np.zeros_like(ys)
    grid.observe(xs + 5, ys, np.full_like(ys, 150.0))
    grid.observe(xs - 15, ys, np.zeros_like(ys))
    return grid, Terrain(grid, 15.0, 35.0).blocked(60.0, 120.0)


def test_path_bends_around_what_is_too_tall_to_overfly() -> None:
    grid, blocked = wall_grid()
    start, goal = np.array([-50.0, 50.0, 60.0]), np.array([50.0, 50.0])
    assert not line_clear(grid, blocked, start, goal)
    path = plan(grid, blocked, start, goal)
    assert path is not None and np.allclose(path[-1], goal)
    here = start[:2]
    for p in path:
        assert line_clear(grid, blocked, here, p)
        here = p
    assert min(p[1] for p in path) < -55


def test_unreachable_goal_has_no_path() -> None:
    grid, blocked = wall_grid()
    assert plan(grid, blocked, np.array([-50.0, 50.0, 60.0]), np.array([5.0, 50.0])) is None


def test_terrain_climbs_over_tall_cells_ahead() -> None:
    grid = MissionGrid(radius_m=200.0, cell_m=10.0, margin_m=0.0)
    grid.observe(np.array([45.0, 35.0]), np.array([5.0, 5.0]), np.array([70.0, 0.0]))
    terrain = Terrain(grid, 15.0, 0.0)
    z = terrain.target_z(np.array([0.0, 5.0, 60.0]), np.array([10.0, 0.0, 0.0]), 60.0, 120.0, 5.0)
    assert z == 85.0


def test_assignment_is_the_same_from_every_drone() -> None:
    grid = MissionGrid(radius_m=200.0, cell_m=10.0, margin_m=0.0)
    plan_ = TilePlan(grid, 50.0)
    tiles = [
        GoalTile(1, -100.0, 0.0, 1.0),
        GoalTile(2, 100.0, 0.0, 1.0),
        GoalTile(3, 0.0, 150.0, 1.0),
    ]
    agents = [Agent("b", 90.0, 10.0, None), Agent("a", -90.0, 10.0, None)]
    one = assign(agents, tiles, plan_, 50.0)
    other = assign(list(reversed(agents)), list(reversed(tiles)), plan_, 50.0)
    assert one == other
    assert one["a"] == tiles[0] and one["b"] == tiles[1]


def test_current_goal_is_kept_against_a_slightly_closer_tile() -> None:
    grid = MissionGrid(radius_m=200.0, cell_m=10.0, margin_m=0.0)
    plan_ = TilePlan(grid, 50.0)
    near = GoalTile(1, 40.0, 0.0, 1.0)
    held_id = plan_.tile_id(-60.0, 0.0)
    assert held_id is not None
    held = GoalTile(held_id, -60.0, 0.0, 1.0)
    got = assign([Agent("a", 0.0, 0.0, (-60.0, 0.0))], [near, held], plan_, 50.0)
    assert got["a"] == held
    fresh = assign([Agent("a", 0.0, 0.0, None)], [near, held], plan_, 50.0)
    assert fresh["a"] == near


def test_leftover_drones_get_no_goal() -> None:
    grid = MissionGrid(radius_m=200.0, cell_m=10.0, margin_m=0.0)
    got = assign(
        [Agent("a", 0, 0, None), Agent("b", 5, 5, None)],
        [GoalTile(1, 9, 9, 1.0)],
        TilePlan(grid, 50),
        0,
    )
    assert sorted(v is None for v in got.values()) == [False, True]
