from app.geo.grid import ZoneGrid
from app.zones.edge import CoverageModel, EdgeServer, plan_edge_servers

SQUARE = [(34.18, -118.08), (34.18, -118.0365), (34.216, -118.0365), (34.216, -118.08)]
# An east-west road about 1 km south of the square's middle.
ROAD_OFF_CENTER = [[(34.189, -118.09), (34.189, -118.03)]]


def plan(roads, **overrides):
    grid = ZoneGrid.from_polygon(SQUARE, 100)
    params = dict(
        radius_m=1500,
        spacing_m=250,
        road_access_m=200,
        off_road_weight=0.75,
        target=0.9,
        max_servers=20,
    )
    params.update(overrides)
    return grid, plan_edge_servers(grid, SQUARE, roads, **params)


def test_greedy_cover_reaches_target() -> None:
    _, (servers, pct) = plan(roads=[])
    assert pct >= 90
    # A 1.5 km radius covers about 7 km2, so a 16 km2 square needs a handful, not dozens.
    assert 2 <= len(servers) <= 8
    assert all(s.status == "pending" for s in servers)
    assert len({s.id for s in servers}) == len(servers)


def test_each_server_adds_coverage() -> None:
    grid, (servers, _) = plan(roads=[])
    model = CoverageModel(grid, SQUARE)
    previous = 0.0
    for k in range(1, len(servers) + 1):
        pct = model.coverage_pct(servers[:k])
        assert pct > previous
        previous = pct


def test_stops_at_max_servers() -> None:
    _, (servers, pct) = plan(roads=[], max_servers=1)
    assert len(servers) == 1
    assert pct < 90


def test_prefers_candidates_near_roads() -> None:
    # A dock by the road covers nearly as much as one in the middle, so it wins.
    _, (servers, _) = plan(roads=ROAD_OFF_CENTER, max_servers=1)
    assert servers[0].near_road
    assert abs(servers[0].lat - 34.189) < 0.003


def test_road_preference_is_a_weight_not_a_rule() -> None:
    # With no penalty for being off-road, the first pick is the best-covering spot.
    _, (servers, _) = plan(roads=ROAD_OFF_CENTER, max_servers=1, off_road_weight=1.0)
    assert not servers[0].near_road


def test_coverage_of_an_edited_list() -> None:
    grid = ZoneGrid.from_polygon(SQUARE, 100)
    model = CoverageModel(grid, SQUARE)
    middle = EdgeServer("a", 34.198, -118.058, 1500, "deployed")
    corner = EdgeServer("b", 34.18, -118.08, 1500, "deployed")
    far_away = EdgeServer("c", 35.0, -119.0, 1500, "deployed")
    assert model.coverage_pct([]) == 0
    assert model.coverage_pct([far_away]) == 0
    assert model.coverage_pct([middle]) > model.coverage_pct([corner])
    assert model.coverage_pct([middle, corner]) >= model.coverage_pct([middle])
