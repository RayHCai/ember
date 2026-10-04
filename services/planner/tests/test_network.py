from conftest import FRAME, ll
from ember_planner.network import road_network, travel_minutes
from ember_planner.wire import Road


def road(rid: str, *pts: tuple[float, float]) -> Road:
    return Road.model_validate(
        {"id": rid, "name": None, "kind": "primary", "path": [ll(x, y) for x, y in pts]}
    )


def reachable(roads: list[Road], a: tuple[float, float], b: tuple[float, float]) -> bool:
    net = road_network(roads, FRAME, 40.0)
    assert net is not None
    start, _ = net.nearest(*a)
    goal, d = net.nearest(*b)
    assert d < 2
    return bool(travel_minutes(net, {start: 0.0})[goal] < float("inf"))


def test_t_junction_joins_mid_segment() -> None:
    roads = [road("a", (-1000, 0), (1000, 0)), road("b", (333.3, 0), (333.3, 900))]
    assert reachable(roads, (-1000, 0), (333.3, 900))


def test_crossing_roads_join() -> None:
    roads = [road("a", (-1000, 7), (1000, 7)), road("b", (13, -900), (13, 900))]
    assert reachable(roads, (-1000, 7), (13, 900))


def test_separate_roads_do_not_join() -> None:
    roads = [road("a", (-1000, 0), (1000, 0)), road("b", (0, 100), (0, 900))]
    assert not reachable(roads, (-1000, 0), (0, 900))


def test_no_roads_is_no_network() -> None:
    assert road_network([], FRAME, 40.0) is None
