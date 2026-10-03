"""Roads, communities and shelter candidates from OpenStreetMap (Overpass API).

Every response is cached on disk by bounding box, so a zone that loaded once
loads again on bad Wi-Fi. With no network and no cache, a synthetic road
lattice stands in, and the result says so.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import time
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .. import config
from .core import LatLon, LocalProjection, bbox, centroid, expand_bbox, point_in_polygon, simplify

log = logging.getLogger(__name__)

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "Ember/0.1 (MHacks 2026 wildfire watch console)"
TIMEOUT_S = 25  # Overpass's own query timeout
BUDGET_S = 40.0  # total time across mirrors before falling back
ROAD_KINDS = "primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified"
ROAD_KIND_SET = frozenset(ROAD_KINDS.split("|"))
PLACE_KINDS = ("city", "town", "village", "hamlet", "suburb")
# Places within the zone's margin come first. If there are none (a zone deep in
# wildland), the nearest few within the wider shelter search area stand in.
FALLBACK_COMMUNITIES = 4
# Bump when the query changes so old cached responses are not reused.
QUERY_VERSION = 3
SHELTER_KINDS = ("school", "community_centre")
ROAD_SIMPLIFY_M = 12.0

Bbox = tuple[float, float, float, float]


@dataclass
class Road:
    id: str
    kind: str
    name: str | None
    points: list[LatLon]


@dataclass
class Place:
    id: str
    name: str
    lat: float
    lon: float
    kind: str
    population: int | None = None


@dataclass
class OsmData:
    roads: list[Road] = field(default_factory=list)
    communities: list[Place] = field(default_factory=list)
    amenities: list[Place] = field(default_factory=list)
    # "osm" (fresh), "cache" (from disk), or "synthetic" (fallback lattice)
    source: str = "osm"
    note: str | None = None

    def to_payload(self) -> dict:
        return {
            "source": self.source,
            "note": self.note,
            "roads": [{"id": r.id, "kind": r.kind, "name": r.name, "points": [list(p) for p in r.points]} for r in self.roads],
            "communities": [asdict(c) for c in self.communities],
        }


def _fmt(b: Bbox) -> str:
    return ",".join(f"{v:.5f}" for v in b)


def build_query(area: Bbox, shelter_area: Bbox) -> str:
    a, s = _fmt(area), _fmt(shelter_area)
    return f"""[out:json][timeout:{TIMEOUT_S}];
way["highway"~"^({ROAD_KINDS})$"]({a});
out geom tags;
node["place"~"^({'|'.join(PLACE_KINDS)})$"]({s});
out body;
nwr["amenity"~"^({'|'.join(SHELTER_KINDS)})$"]({s});
out center tags;
way["landuse"="residential"]({a});
out center tags;
"""


def cache_key(area: Bbox) -> str:
    rounded = ",".join(f"{v:.4f}" for v in area) + f"|v{QUERY_VERSION}"
    return hashlib.sha1(rounded.encode()).hexdigest()[:16]


def _cache_files(key: str) -> list[Path]:
    return [config.CACHE_DIR / "osm" / f"{key}.json", config.BUNDLED_CACHE_DIR / "osm" / f"{key}.json"]


def fetch_overpass(query: str) -> dict:
    """POST a query to Overpass, trying each mirror. Raises on failure."""
    body = urllib.parse.urlencode({"data": query}).encode()
    errors = []
    deadline = time.monotonic() + BUDGET_S
    for url in OVERPASS_URLS:
        remaining = deadline - time.monotonic()
        if remaining < 5:
            break
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=min(TIMEOUT_S + 5, remaining)) as res:
                return json.loads(res.read())
        except Exception as err:  # network, HTTP or JSON errors all mean "try the next one"
            errors.append(f"{urllib.parse.urlparse(url).netloc}: {err}")
    raise RuntimeError("; ".join(errors))


def _center(el: dict) -> LatLon | None:
    if "lat" in el and "lon" in el:
        return (el["lat"], el["lon"])
    c = el.get("center")
    return (c["lat"], c["lon"]) if c else None


def _population(tags: dict) -> int | None:
    raw = str(tags.get("population", "")).replace(",", "").strip()
    return int(raw) if raw.isdigit() else None


def _in_bbox(p: Place, b: Bbox) -> bool:
    return b[0] <= p.lat <= b[2] and b[1] <= p.lon <= b[3]


def parse(raw: dict, zone_polygon: Sequence[LatLon]) -> tuple[list[Road], list[Place], list[Place]]:
    roads: list[Road] = []
    places: list[Place] = []
    amenities: list[Place] = []
    residential: list[tuple[float, Place]] = []

    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        el_id = f"{el['type']}/{el['id']}"
        if tags.get("highway") in ROAD_KIND_SET and el.get("geometry"):
            points = [(g["lat"], g["lon"]) for g in el["geometry"]]
            roads.append(Road(el_id, tags["highway"], tags.get("name"), simplify(points, ROAD_SIMPLIFY_M)))
        elif tags.get("place") in PLACE_KINDS and "lat" in el:
            name = tags.get("name") or tags["place"].title()
            places.append(Place(el_id, name, el["lat"], el["lon"], tags["place"], _population(tags)))
        elif tags.get("amenity") in SHELTER_KINDS:
            c = _center(el)
            if c:
                name = tags.get("name") or tags["amenity"].replace("_", " ").title()
                amenities.append(Place(el_id, name, c[0], c[1], tags["amenity"]))
        elif tags.get("landuse") == "residential":
            c = _center(el)
            b = el.get("bounds")
            if c and b:
                size = (b["maxlat"] - b["minlat"]) * (b["maxlon"] - b["minlon"])
                residential.append((size, Place(el_id, tags.get("name") or "Residential area", c[0], c[1], "residential")))

    area = expand_bbox(bbox(zone_polygon), config.OSM_MARGIN_M)
    communities = [p for p in places if _in_bbox(p, area)]
    if not communities and places:
        proj = LocalProjection(centroid(zone_polygon))
        places.sort(key=lambda p: math.hypot(*proj.to_xy((p.lat, p.lon))))
        communities = places[:FALLBACK_COMMUNITIES]
    if not communities:
        # No named places nearby: use the largest residential areas instead.
        residential.sort(key=lambda r: r[0], reverse=True)
        communities = [p for _, p in residential[:6]]
        for i, p in enumerate(communities, 1):
            if p.name == "Residential area":
                p.name = f"Residential area {i}"
    return roads, communities, amenities


def synthetic(zone_polygon: Sequence[LatLon], reason: str) -> OsmData:
    """A 1 km road lattice with placeholder communities and shelters (SIM)."""
    area = expand_bbox(bbox(zone_polygon), config.OSM_MARGIN_M)
    s, w, n, e = area
    proj = LocalProjection((s, w))
    width, height = proj.to_xy((s, e))[0], proj.to_xy((n, w))[1]
    roads = []
    for k in range(int(height // 1000) + 1):
        y = k * 1000.0
        roads.append(Road(f"sim/h{k}", "synthetic", None, [proj.to_latlon(0, y), proj.to_latlon(width, y)]))
    for k in range(int(width // 1000) + 1):
        x = k * 1000.0
        roads.append(Road(f"sim/v{k}", "synthetic", None, [proj.to_latlon(x, 0), proj.to_latlon(x, height)]))
    mid_lat, mid_lon = (s + n) / 2, (w + e) / 2
    communities = [
        Place("sim/c1", "Community A (SIM)", s + (n - s) * 0.08, mid_lon, "synthetic", 2000),
        Place("sim/c2", "Community B (SIM)", mid_lat, e - (e - w) * 0.08, "synthetic", 800),
        Place("sim/c3", "Community C (SIM)", n - (n - s) * 0.08, w + (w - e) * -0.2, "synthetic", 300),
    ]
    amenities = [
        Place("sim/s1", "Shelter A (SIM)", s + (n - s) * 0.03, w + (e - w) * 0.25, "synthetic"),
        Place("sim/s2", "Shelter B (SIM)", s + (n - s) * 0.03, e - (e - w) * 0.25, "synthetic"),
    ]
    return OsmData(roads, communities, amenities, "synthetic", reason)


def load_osm(zone_polygon: Sequence[LatLon], fetch=fetch_overpass) -> OsmData:
    """Roads and places around a zone: from cache, then Overpass, then synthetic."""
    area = expand_bbox(bbox(zone_polygon), config.OSM_MARGIN_M)
    shelter_area = expand_bbox(bbox(zone_polygon), config.SHELTER_SEARCH_MARGIN_M)
    key = cache_key(area)

    for path in _cache_files(key):
        if path.exists():
            raw = json.loads(path.read_text())
            return OsmData(*parse(raw, zone_polygon), source="cache")

    if config.OSM_OFFLINE:
        return synthetic(zone_polygon, "Offline mode (EMBER_OSM_OFFLINE) and no cached OpenStreetMap data. Using a synthetic road grid.")

    try:
        raw = fetch(build_query(area, shelter_area))
    except Exception as err:
        log.warning("Overpass failed: %s", err)
        return synthetic(zone_polygon, f"OpenStreetMap unavailable ({err}). Using a synthetic road grid.")

    path = _cache_files(key)[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw))
    return OsmData(*parse(raw, zone_polygon), source="osm")


def suggest_shelters(zone_polygon: Sequence[LatLon], amenities: Sequence[Place], count: int) -> list[Place]:
    """The nearest schools or community centres outside the zone, at least 1 km apart."""
    center = centroid(zone_polygon)
    proj = LocalProjection(center)
    outside = [a for a in amenities if not point_in_polygon((a.lat, a.lon), zone_polygon)]
    generic = {k.replace("_", " ").title() for k in SHELTER_KINDS}
    # Named sites first (an operator can find "Vista High School", not "School"), then nearest.
    outside.sort(key=lambda a: (a.name in generic, math.hypot(*proj.to_xy((a.lat, a.lon)))))
    chosen: list[Place] = []
    for a in outside:
        ax, ay = proj.to_xy((a.lat, a.lon))
        if all(math.hypot(ax - bx, ay - by) >= 1000 for bx, by in (proj.to_xy((c.lat, c.lon)) for c in chosen)):
            chosen.append(a)
        if len(chosen) == count:
            break
    return chosen
