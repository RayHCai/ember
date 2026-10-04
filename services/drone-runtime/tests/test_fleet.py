import itertools

import pytest
from ember_drone_runtime.fleet import fleet_members
from ember_drone_runtime.geo import LatLng, LocalFrame

HOME = LatLng(20.8838, -156.6670)


def test_members_are_named_and_ringed_around_home() -> None:
    members = fleet_members("sim", 2, HOME)
    assert [(m.drone_id, m.name) for m in members] == [("sim-1", "Osprey"), ("sim-2", "Harrier")]
    local = LocalFrame(HOME)
    xy = [local.point_xy(m.home.lat, m.home.lng) for m in members]
    for x, y in xy:
        assert (x**2 + y**2) ** 0.5 == pytest.approx(12.0, abs=0.1)
    for (ax, ay), (bx, by) in itertools.combinations(xy, 2):
        assert ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 > 10.0


def test_large_fleets_fall_back_to_numbered_names() -> None:
    members = fleet_members("sim", 10, HOME)
    assert len({m.drone_id for m in members}) == 10
    assert members[-1].name == "Sim 10"


def test_empty_fleet_is_rejected() -> None:
    with pytest.raises(ValueError):
        fleet_members("sim", 0, HOME)
