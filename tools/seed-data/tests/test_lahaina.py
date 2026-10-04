from collections import deque

from ember_seed_data.lahaina import COVERAGE_BOX, LatLng, lahaina


def in_box(p: LatLng) -> bool:
    return (
        COVERAGE_BOX["lat_min"] <= p.lat <= COVERAGE_BOX["lat_max"]
        and COVERAGE_BOX["lng_min"] <= p.lng <= COVERAGE_BOX["lng_max"]
    )


def inside(p: LatLng, ring: list[LatLng]) -> bool:
    result = False
    for a, b in zip(ring, ring[1:] + ring[:1], strict=True):
        if (a.lat > p.lat) != (b.lat > p.lat):
            cross = (b.lng - a.lng) * (p.lat - a.lat) / (b.lat - a.lat) + a.lng
            if p.lng < cross:
                result = not result
    return result


def test_every_point_in_coverage_box() -> None:
    seed = lahaina()
    geo = seed.geography
    points = list(seed.zone.boundary)
    points += [p for r in geo.roads for p in r.path]
    points += [a.center for a in geo.civilian_areas]
    points += [p for a in geo.civilian_areas for p in a.polygon or []]
    points += [s.location for s in geo.safe_zones] + [s.location for s in geo.stations]
    points += [e.location for e in seed.edge_servers] + [c.location for c in seed.civilians]
    assert all(in_box(p) for p in points)


def test_shapes_and_unique_ids() -> None:
    seed = lahaina()
    geo = seed.geography
    assert 10 <= len(seed.zone.boundary) <= 16
    assert all(len(a.polygon) >= 3 for a in geo.civilian_areas if a.polygon)
    assert all(2 <= len(r.path) <= 12 for r in geo.roads)
    assert 12 <= len(geo.roads) <= 18
    assert len(seed.edge_servers) == 3 and len(seed.responders) == 6
    assert len(seed.civilians) == 8
    for ids in (
        [r.id for r in geo.roads],
        [a.id for a in geo.civilian_areas],
        [s.id for s in geo.safe_zones],
        [s.id for s in geo.stations],
        [e.edge_server_id for e in seed.edge_servers],
        [c.email for c in seed.civilians],
        [r.name for r in seed.responders],
    ):
        assert len(ids) == len(set(ids))


def test_references_exist() -> None:
    seed = lahaina()
    areas = {a.id for a in seed.geography.civilian_areas}
    stations = {s.id for s in seed.geography.stations}
    assert all(c.civilian_area_id in areas for c in seed.civilians)
    assert all(r.station_id in stations for r in seed.responders)
    assert next(
        c for c in seed.civilians if c.email == "civilian4@example.com"
    ).civilian_area_id == ("area-lahaina-bypass")


def test_people_and_facilities_inside_zone() -> None:
    seed = lahaina()
    ring = seed.zone.boundary
    assert all(inside(c.location, ring) for c in seed.civilians)
    assert all(inside(e.location, ring) for e in seed.edge_servers)
    assert all(inside(a.center, ring) for a in seed.geography.civilian_areas)


def test_road_network_connected() -> None:
    roads = lahaina().geography.roads
    by_point: dict[tuple[float, float], set[str]] = {}
    for road in roads:
        for p in road.path:
            by_point.setdefault((p.lat, p.lng), set()).add(road.id)
    adjacency: dict[str, set[str]] = {r.id: set() for r in roads}
    for ids in by_point.values():
        for a in ids:
            adjacency[a] |= ids - {a}
    seen = {roads[0].id}
    queue = deque(seen)
    while queue:
        for nxt in adjacency[queue.popleft()] - seen:
            seen.add(nxt)
            queue.append(nxt)
    assert seen == set(adjacency)


def test_demo_roads_present() -> None:
    kinds = {r.id: r.kind for r in lahaina().geography.roads}
    assert kinds["r-hwy-30"] == "primary" and kinds["r-ridge-rd"] == "track"
    assert kinds["r-kuialua-st"] == "residential"
