import json
from pathlib import Path

import pytest

from app import config
from app.geo import osm

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "overpass_small.json").read_text())
ZONE = [(34.19, -118.09), (34.19, -118.03), (34.225, -118.03), (34.225, -118.09)]


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "BUNDLED_CACHE_DIR", tmp_path / "bundled")


def test_parse_roads_places_and_amenities() -> None:
    roads, communities, amenities = osm.parse(FIXTURE, ZONE)
    # Paths and footways are not driveable, even if Overpass returns them.
    assert {r.kind for r in roads} == {"secondary", "residential"}
    names = {c.name for c in communities}
    assert names == {"Sierra Vista", "Pine Flat"}
    town = next(c for c in communities if c.name == "Sierra Vista")
    assert town.population == 12400
    assert {a.name for a in amenities} == {"Vista High School", "Eastside Hall", "Inside School"}
    ridge = next(r for r in roads if r.name == "Ridge Road")
    # Collinear points are simplified away.
    assert len(ridge.points) == 2


def test_query_only_asks_for_driveable_roads() -> None:
    query = osm.build_query((34.0, -118.1, 34.1, -118.0), (33.9, -118.2, 34.2, -117.9))
    assert "footway" not in query
    assert "residential" in query and "unclassified" in query and "primary" in query
    assert 'place"~"^(city|town|village|hamlet|suburb)$' in query
    # Every output must carry coordinates: "out tags" drops them.
    assert "out tags;" not in query


def test_shelters_are_outside_the_zone_and_nearest_first() -> None:
    _, _, amenities = osm.parse(FIXTURE, ZONE)
    shelters = osm.suggest_shelters(ZONE, amenities, 2)
    assert [s.name for s in shelters] == ["Vista High School", "Eastside Hall"]


def test_fetch_then_cache() -> None:
    calls = []

    def fake_fetch(query):
        calls.append(query)
        return FIXTURE

    first = osm.load_osm(ZONE, fetch=fake_fetch)
    second = osm.load_osm(ZONE, fetch=fake_fetch)
    assert first.source == "osm"
    assert second.source == "cache"
    assert len(calls) == 1
    assert len(second.roads) == len(first.roads)


def test_falls_back_to_synthetic_roads_when_overpass_fails() -> None:
    def broken_fetch(query):
        raise RuntimeError("network is down")

    data = osm.load_osm(ZONE, fetch=broken_fetch)
    assert data.source == "synthetic"
    assert "network is down" in data.note
    assert len(data.roads) > 4
    assert all(c.name.endswith("(SIM)") for c in data.communities)


def test_far_places_stand_in_when_none_are_near() -> None:
    far = {"type": "node", "id": 99, "lat": 34.10, "lon": -118.06, "tags": {"place": "city", "name": "Far City"}}
    raw = {"elements": [e for e in FIXTURE["elements"] if "place" not in e.get("tags", {})] + [far]}
    _, communities, _ = osm.parse(raw, ZONE)
    assert [c.name for c in communities] == ["Far City"]


def test_named_shelters_come_before_generic_ones() -> None:
    near_generic = osm.Place("n/1", "School", 34.188, -118.06, "school")
    far_named = osm.Place("n/2", "Pine Elementary", 34.15, -118.06, "school")
    assert osm.suggest_shelters(ZONE, [near_generic, far_named], 1)[0].name == "Pine Elementary"


def test_offline_mode_never_calls_overpass(monkeypatch) -> None:
    monkeypatch.setattr(config, "OSM_OFFLINE", True)

    def must_not_fetch(query):
        raise AssertionError("fetched in offline mode")

    data = osm.load_osm(ZONE, fetch=must_not_fetch)
    assert data.source == "synthetic"
    assert "Offline mode" in data.note


def test_residential_areas_stand_in_when_there_are_no_places() -> None:
    raw = {"elements": [e for e in FIXTURE["elements"] if "place" not in e.get("tags", {})]}
    _, communities, _ = osm.parse(raw, ZONE)
    assert [c.kind for c in communities] == ["residential"]
