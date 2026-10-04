"""Lahaina demo seed for the August 8, 2023 scenario.

The geography is approximate demo data, not survey-accurate: street paths, areas and facilities are
plausible placements inside the Lahaina coverage box, built so the road network is connected.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

COVERAGE_BOX = {"lat_min": 20.838, "lat_max": 20.915, "lng_min": -156.695, "lng_max": -156.640}


class Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class LatLng(Wire):
    lat: float
    lng: float


class Road(Wire):
    id: str
    name: str
    kind: str
    path: list[LatLng]


class CivilianArea(Wire):
    id: str
    name: str
    center: LatLng
    polygon: list[LatLng] | None
    population: int


class SafeZone(Wire):
    id: str
    name: str
    location: LatLng
    capacity: int | None


class Station(Wire):
    id: str
    name: str
    location: LatLng


class Geography(Wire):
    terrain: None = None
    roads: list[Road]
    civilian_areas: list[CivilianArea]
    safe_zones: list[SafeZone]
    stations: list[Station]


class EdgeServer(Wire):
    edge_server_id: str
    url: str
    location: LatLng
    connectivity_radius_m: int
    name: str


class Responder(Wire):
    name: str
    role: str
    capabilities: list[str]
    station_id: str
    location: LatLng


class Civilian(Wire):
    email: str
    zip_code: str
    civilian_area_id: str
    location: LatLng
    notes: str | None


class Zone(Wire):
    name: str
    boundary: list[LatLng]


class Seed(Wire):
    zone: Zone
    geography: Geography
    edge_servers: list[EdgeServer]
    responders: list[Responder]
    civilians: list[Civilian]

    def to_json(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json")


def _p(lat: float, lng: float) -> LatLng:
    return LatLng(lat=lat, lng=lng)


def _ring(lat: float, lng: float, half: float = 0.0025) -> list[LatLng]:
    return [
        _p(lat + half, lng - half),
        _p(lat + half, lng + half),
        _p(lat - half, lng + half),
        _p(lat - half, lng - half),
    ]


# Junctions are shared by exact coordinates so cross streets connect to the trunk roads.
FRONT_NORTH = _p(20.8920, -156.6870)
FRONT_KAHOMA = _p(20.8850, -156.6835)
FRONT_SHAW = _p(20.8800, -156.6815)
FRONT_KEAWE = _p(20.8760, -156.6805)
FRONT_LAHAINALUNA = _p(20.8720, -156.6800)
FRONT_DICKENSON = _p(20.8680, -156.6770)
FRONT_SOUTH = _p(20.8620, -156.6735)

HWY_NORTH_EXIT = _p(20.9035, -156.6768)
HWY_RIDGE = _p(20.8990, -156.6775)
HWY_WAHIKULI = _p(20.8930, -156.6770)
HWY_KAHOMA = _p(20.8870, -156.6740)
HWY_SHAW = _p(20.8800, -156.6720)
HWY_KEAWE = _p(20.8770, -156.6718)
HWY_LAHAINALUNA = _p(20.8740, -156.6715)
HWY_DICKENSON = _p(20.8680, -156.6700)
HWY_SOUTH = _p(20.8620, -156.6680)

WAINEE_SHAW = _p(20.8800, -156.6770)
WAINEE_KEAWE = _p(20.8765, -156.6762)
WAINEE_LAHAINALUNA = _p(20.8728, -156.6760)
WAINEE_DICKENSON = _p(20.8690, -156.6735)

LUNA_BYPASS = _p(20.8765, -156.6670)
LUNA_KUIALUA = _p(20.8790, -156.6630)
LUNA_RIDGE = _p(20.8830, -156.6560)
KUIALUA_RIDGE = _p(20.8850, -156.6610)
WAHIKULI_CIVIC = _p(20.8925, -156.6820)
CIVIC_CENTER = _p(20.8970, -156.6820)
PUAMANA_BEACH = _p(20.8590, -156.6700)


def _roads() -> list[Road]:
    def road(id_: str, name: str, kind: str, *path: LatLng) -> Road:
        return Road(id=id_, name=name, kind=kind, path=list(path))

    return [
        road(
            "r-hwy-30",
            "Highway 30 (Honoapiilani Hwy)",
            "primary",
            HWY_NORTH_EXIT,
            HWY_RIDGE,
            HWY_WAHIKULI,
            HWY_KAHOMA,
            HWY_SHAW,
            HWY_KEAWE,
            HWY_LAHAINALUNA,
            HWY_DICKENSON,
            HWY_SOUTH,
        ),
        road(
            "r-front-st",
            "Front St",
            "secondary",
            FRONT_NORTH,
            FRONT_KAHOMA,
            FRONT_SHAW,
            FRONT_KEAWE,
            FRONT_LAHAINALUNA,
            FRONT_DICKENSON,
            FRONT_SOUTH,
        ),
        road(
            "r-lahainaluna-rd",
            "Lahainaluna Rd",
            "secondary",
            FRONT_LAHAINALUNA,
            WAINEE_LAHAINALUNA,
            HWY_LAHAINALUNA,
            LUNA_BYPASS,
            LUNA_KUIALUA,
            _p(20.8815, -156.6595),
            LUNA_RIDGE,
        ),
        road(
            "r-kuialua-st",
            "Kuialua St",
            "residential",
            LUNA_KUIALUA,
            _p(20.8825, -156.6625),
            KUIALUA_RIDGE,
        ),
        road(
            "r-ridge-rd",
            "Ridge Rd",
            "track",
            LUNA_RIDGE,
            KUIALUA_RIDGE,
            _p(20.8900, -156.6640),
            _p(20.8960, -156.6690),
            _p(20.8985, -156.6745),
            HWY_RIDGE,
        ),
        road(
            "r-keawe-st",
            "Keawe St",
            "residential",
            FRONT_KEAWE,
            WAINEE_KEAWE,
            HWY_KEAWE,
        ),
        road(
            "r-shaw-st",
            "Shaw St",
            "residential",
            FRONT_SHAW,
            WAINEE_SHAW,
            HWY_SHAW,
        ),
        road(
            "r-dickenson-st",
            "Dickenson St",
            "residential",
            FRONT_DICKENSON,
            WAINEE_DICKENSON,
            HWY_DICKENSON,
        ),
        road(
            "r-wainee-st",
            "Wainee St",
            "residential",
            WAINEE_SHAW,
            WAINEE_KEAWE,
            WAINEE_LAHAINALUNA,
            WAINEE_DICKENSON,
        ),
        road(
            "r-kahoma-bypass",
            "Kahoma Bypass",
            "secondary",
            FRONT_KAHOMA,
            _p(20.8860, -156.6790),
            HWY_KAHOMA,
        ),
        road(
            "r-lahaina-bypass",
            "Lahaina Bypass",
            "primary",
            HWY_WAHIKULI,
            _p(20.8890, -156.6700),
            _p(20.8830, -156.6685),
            LUNA_BYPASS,
        ),
        road(
            "r-wahikuli-rd",
            "Wahikuli Rd",
            "secondary",
            FRONT_NORTH,
            WAHIKULI_CIVIC,
            HWY_WAHIKULI,
        ),
        road(
            "r-civic-center-rd",
            "Civic Center Rd",
            "residential",
            WAHIKULI_CIVIC,
            _p(20.8948, -156.6820),
            CIVIC_CENTER,
        ),
        road(
            "r-puamana-rd",
            "Puamana Rd",
            "secondary",
            FRONT_SOUTH,
            _p(20.8605, -156.6718),
            PUAMANA_BEACH,
            HWY_SOUTH,
        ),
    ]


def _areas() -> list[CivilianArea]:
    def area(
        id_: str, name: str, lat: float, lng: float, population: int, ring: bool
    ) -> CivilianArea:
        return CivilianArea(
            id=id_,
            name=name,
            center=_p(lat, lng),
            polygon=_ring(lat, lng) if ring else None,
            population=population,
        )

    return [
        area("area-lahaina-town", "Lahaina Town", 20.8725, -156.6795, 2400, True),
        area("area-kelawea-mauka", "Kelawea Mauka", 20.8785, -156.6640, 900, True),
        area("area-kahoma", "Kahoma", 20.8870, -156.6790, 1400, True),
        area("area-wahikuli", "Wahikuli", 20.8945, -156.6830, 1800, False),
        area("area-puamana", "Puamana", 20.8600, -156.6720, 700, False),
        area("area-lahaina-bypass", "Lahaina Bypass Homes", 20.8850, -156.6690, 500, True),
    ]


def _responders() -> list[Responder]:
    def responder(name: str, role: str, capabilities: list[str], station: Station) -> Responder:
        return Responder(
            name=name,
            role=role,
            capabilities=capabilities,
            station_id=station.id,
            location=station.location,
        )

    fire_3 = _stations()[0]
    staging = _stations()[1]
    return [
        responder("Engine 3", "engine", ["structure_protection", "pumping"], fire_3),
        responder("Engine 7", "engine", ["structure_protection", "pumping"], fire_3),
        responder("Hand Crew Alpha", "hand_crew", ["line_construction", "mop_up"], staging),
        responder("Dozer 1", "dozer", ["firebreak"], staging),
        responder("Water Tender 2", "water_tender", ["water_supply"], fire_3),
        responder("Medic 5", "medic", ["triage", "transport"], staging),
    ]


def _stations() -> list[Station]:
    return [
        Station(
            id="station-lahaina-fire-3", name="Lahaina Fire Station 3", location=HWY_LAHAINALUNA
        ),
        Station(
            id="station-west-maui-staging", name="West Maui Staging Area", location=WAHIKULI_CIVIC
        ),
    ]


def _civilians() -> list[Civilian]:
    spec: list[tuple[str, float, float, str | None]] = [
        ("area-lahaina-town", 20.8730, -156.6790, "two dogs"),
        ("area-kelawea-mauka", 20.8788, -156.6645, None),
        ("area-puamana", 20.8602, -156.6725, "uses a wheelchair"),
        ("area-lahaina-bypass", 20.8852, -156.6692, None),
        ("area-wahikuli", 20.8942, -156.6835, "elderly parent at home"),
        ("area-kahoma", 20.8872, -156.6785, None),
        ("area-lahaina-town", 20.8718, -156.6798, "no car"),
        ("area-kelawea-mauka", 20.8781, -156.6635, None),
    ]
    return [
        Civilian(
            email=f"civilian{i}@example.com",
            zip_code="96761",
            civilian_area_id=area_id,
            location=_p(lat, lng),
            notes=notes,
        )
        for i, (area_id, lat, lng, notes) in enumerate(spec, start=1)
    ]


def lahaina() -> Seed:
    boundary = [
        _p(20.8570, -156.6725),
        _p(20.8650, -156.6775),
        _p(20.8730, -156.6830),
        _p(20.8810, -156.6860),
        _p(20.8900, -156.6895),
        _p(20.9040, -156.6850),
        _p(20.9050, -156.6760),
        _p(20.9000, -156.6640),
        _p(20.8900, -156.6560),
        _p(20.8840, -156.6500),
        _p(20.8760, -156.6520),
        _p(20.8680, -156.6580),
        _p(20.8600, -156.6650),
    ]
    edge_sites = [
        ("edge-lahaina-1", "Lahaina Town edge", _p(20.8700, -156.6760)),
        ("edge-lahaina-2", "Kelawea Mauka edge", _p(20.8830, -156.6700)),
        ("edge-lahaina-3", "Wahikuli edge", _p(20.8930, -156.6790)),
    ]
    return Seed(
        zone=Zone(name="Lahaina", boundary=boundary),
        geography=Geography(
            roads=_roads(),
            civilian_areas=_areas(),
            safe_zones=[
                SafeZone(
                    id="sz-civic-center",
                    name="Lahaina Civic Center",
                    location=CIVIC_CENTER,
                    capacity=1200,
                ),
                SafeZone(
                    id="sz-puamana-beach-park",
                    name="Puamana Beach Park",
                    location=PUAMANA_BEACH,
                    capacity=400,
                ),
                SafeZone(
                    id="sz-kaanapali-exit",
                    name="Highway 30 north exit to Kaanapali",
                    location=HWY_NORTH_EXIT,
                    capacity=None,
                ),
            ],
            stations=_stations(),
        ),
        edge_servers=[
            EdgeServer(
                edge_server_id=id_,
                url=f"http://{id_}.local:8070",
                location=loc,
                connectivity_radius_m=1500,
                name=name,
            )
            for id_, name, loc in edge_sites
        ],
        responders=_responders(),
        civilians=_civilians(),
    )
