"""Geocode time-stamped fire sightings from the FSRI Lahaina timeline into anchors.csv.

The FSRI dataset (CC BY-SA 4.0) redacts house numbers ("7XX Kuʻialua St") and truncates
coordinates, and many rows carry the address of the original 911 incident rather than the
place being described. So each anchor below was picked by hand from the note text, and its
location is resolved against OpenStreetMap (data/raw/osm_lahaina.json):

    ("x", A, B)        intersection of two named roads
    ("poi", name)      a named landmark
    ("street", name)   the middle of a named road (low precision; roads longer than ~600 m
                       were left out because their midpoint says little about where the fire was)
    ("coord", lat, lon) coordinates given in the FSRI row itself

Run:  uv run python scripts/build_anchors.py
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, Point, Polygon
from shapely.ops import linemerge, nearest_points, unary_union, transform

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from demo_data.config import ANCHORS_CSV, RAW_DIR  # noqa: E402
from demo_data.geo import from_utm, to_utm  # noqa: E402

# (time HST, location spec, FSRI source, quote). Times are the FSRI report times.
SIGHTINGS = [
    ("2023-08-08 14:55", ("street_end", "Kuialua Street"), "Event Chronology Report", "Numerous callers. At the end of the cul de sac of Kuʻialua. Caller said fire spreading fast."),
    ("2023-08-08 15:05", ("street", "Hookahua Place"), "PD Dispatch Audio D4", "we got a residence on fire over here [7XX Hoʻokahua]"),
    ("2023-08-08 15:22", ("x", "Lahaina Bypass", "Lahainaluna Road"), "MPD Event Chronology", "E11: Fire jumped the road / Over the Bypass headed west"),
    ("2023-08-08 15:24", ("street", "Kaakolu Street"), "PD Dispatch Audio D4", "We're on Kaʻakolu making checks of the residence, the back of the house is burning."),
    ("2023-08-08 15:39", ("street", "Pauu Place"), "MPD Event Chronology", "Shed on fire. Twenty feet from house. [4XX Pauu Pl]"),
    ("2023-08-08 15:48", ("street", "Komohana Place"), "Dispatch Unredacted 1", "14XX Komohana structure fire next block up ainakea"),
    ("2023-08-08 15:49", ("poi", "Kelawea"), "Dispatch Unredacted 1", "Kelawea has multiple structures on fire"),
    ("2023-08-08 15:50", ("coord", 20.86912, -156.66813), "Dispatch Unredacted 1", "Fire behind homeless shelter"),
    ("2023-08-08 15:57", ("street", "Kalena Street"), "Dispatch Unredacted 1", "House on fire next door at Kalena"),
    ("2023-08-08 15:58", ("street", "Lui Street"), "MPD Event Chronology", "8XX Lui Street fully engulfed"),
    ("2023-08-08 16:03", ("street", "Hakau Place"), "MPD Event Chronology", "Fire jumped to Hakau Pl"),
    ("2023-08-08 16:03", ("street", "Kanakea Loop"), "MPD Event Chronology", "Kanakea loop structure fire ... black smoke"),
    ("2023-08-08 16:16", ("x", "Honoapiilani Highway", "Lahainaluna Road"), "PD Dispatch Audio D4", "The fire jumped the road, uh, jumped Honoapi'ilani"),
    ("2023-08-08 16:21", ("x", "Kenui Street", "Wainee Street"), "MPD Event Chronology", "Hale Ohana Apartments [1XX Kenui St]: grass in the backyard on fire"),
    ("2023-08-08 16:22", ("coord", 20.879011, -156.677998), "Dispatch Unredacted 1", "Fire right behind Subway sandwiches on Lahainaluna and 256 Papalaua Street"),
    ("2023-08-08 16:23", ("poi", "Sugar Cane Train Lahaina Station"), "MPD Event Chronology", "Another caller--train station on fire"),
    ("2023-08-08 16:24", ("poi", "Lahaina Banyan Court"), "MPD Event Chronology", "But the big banyan tree is on fire"),
    ("2023-08-08 16:27", ("street", "David Malo Circle"), "MPD Event Chronology", "Caller from David Malo ... building on fire"),
    ("2023-08-08 16:36", ("x", "Wainee Street", "Dickenson Street"), "PD Dispatch Audio D4", "2XX Waine'e on fire, engulfed next to Lanakila Church ... Dickinson and Waine'e"),
    ("2023-08-08 16:43", ("street", "Baker Street"), "MPD Event Chronology", "Hale Mahaolu [145 Baker St] fully engulfed"),
    ("2023-08-08 16:58", ("street", "Puiki Place"), "Dispatch Unredacted 1", "9XX Puiki Pl: House on fire"),
    ("2023-08-08 16:59", ("x", "Front Street", "Papalaua Street"), "MPD Event Chronology", "Another caller..saying fire on Front St/Papalaua"),
    ("2023-08-08 17:08", ("street", "Kaniau Road"), "Dispatch Unredacted 1", "Fire on other side of my property XX Kaniau Road"),
    ("2023-08-08 17:12", ("street", "Ala Moana Street"), "PD Dispatch Audio D4", "Palm trees on fire in the area [XX Ala Moana]"),
    ("2023-08-08 17:15", ("poi", "Mala Historic Wharf"), "PD Dispatch Audio D4", "Mala Wharf's on fire"),
    ("2023-08-08 17:21", ("x", "Kupuohi Street", "Keawe Street"), "PD Dispatch Audio D4", "Island Grocery Depot [Kupuohi St], the very rear of it is starting to catch on fire"),
    ("2023-08-08 17:34", ("x", "Front Street", "Kenui Street"), "PD Dispatch Audio D4", "the Front Street Apartments starting to catch on fire"),
    ("2023-08-08 17:42", ("x", "Front Street", "Ala Moana Street"), "PD Dispatch Audio D4", "We have a home on Front and Ala Moana fully engulfed."),
    ("2023-08-08 17:44", ("x", "Front Street", "Dickenson Street"), "PD Dispatch Audio D4", "[Front/Dickenson] its on fire all the way down"),
    ("2023-08-08 17:44", ("poi", "Baldwin Home Museum"), "MPD Event Chronology", "418: Baldwin house is on fire"),
    ("2023-08-08 17:44", ("poi", "United States Postal Service"), "MPD Event Chronology", "Post Office on fire, Outlets of Maui on fire, cars too"),
    ("2023-08-08 17:47", ("poi", "Lahaina Aquatic Center"), "PD Dispatch Audio D4", "Lahaina Pool and ... Lahaina Aquatics are catching fire"),
    ("2023-08-08 17:58", ("x", "Front Street", "Kai Pali Place"), "PD Dispatch Audio D4", "there's also a structure on fire, uh .. Kai Pali and Front Street"),
    ("2023-08-08 19:00", ("x", "Front Street", "Shaw Street"), "PD Dispatch Audio D4", "from Shaw and Front to Mala and Front is all engulfed in flames"),
    ("2023-08-08 19:20", ("x", "Honoapiilani Highway", "Keawe Street"), "PD Dispatch Audio D4", "the highway between Keawe and at least Hinau is unpassable. There's flames"),
    ("2023-08-08 19:37", ("x", "Honoapiilani Highway", "Shaw Street"), "PD Dispatch Audio D4", "the fire went jump over from Shaw Street into the neighborhood across the highway"),
    ("2023-08-08 20:00", ("poi", "Minit Stop"), "PD Dispatch Audio D4", "brush fire started right at the bottom by the Bypass right by Minit Stop"),
    ("2023-08-08 20:44", ("x", "Aulike Street", "Leoleo Street"), "MPD Event Chronology", "4A40: Aulike/Leoleo fully engulfed"),
    ("2023-08-08 21:33", ("street", "Kahoma Street"), "PD Dispatch Audio D4", "The flames are in the backyard of a lot of topside houses on Kahoma Street."),
    ("2023-08-08 21:34", ("street", "Fleming Road"), "PD Dispatch Audio D4", "getting reports of flames behind 1XX Fleming"),
    ("2023-08-08 21:46", ("x", "Akeke Place", "Kahoma Street"), "PD Dispatch Audio D4", "its right at Akeke and Kahoma"),
    ("2023-08-08 21:47", ("street", "Malo Street"), "PD Dispatch Audio D4", "just need to confirm that location, 1XX Malo."),
    ("2023-08-08 22:24", ("x", "Honoapiilani Highway", "Fleming Road"), "PD Dispatch Audio D4", "Fire jumped the highway from just south of Fleming. There's multiple spots."),
    ("2023-08-08 22:27", ("x", "Front Street", "Fleming Road"), "PD Dispatch Audio D4", "The church, uh, on the north end of Front Street and Fleming Road is on fire"),
    ("2023-08-08 22:28", ("x", "Hokiokio Place", "Lahaina Bypass"), "MPD Event Chronology", "W2: Fire jumped Hokiokio"),
    ("2023-08-08 22:49", ("street", "Leialii Parkway"), "MPD Event Chronology", "415: Fire coming up Leialiʻi"),
    ("2023-08-09 04:49", ("street", "Hanohano Street"), "MPD Event Chronology", "res on Hanohano deck is on fire"),
    ("2023-08-09 05:02", ("x", "Waianukole Place", "Kai Hele Ku Street"), "Event Chronology", "16XX Waianukole St (cross street Kai Hele Ku): Trailer on fire, Propane in trailer"),
    ("2023-08-09 05:49", ("x", "Kai Hele Ku Street", "Lahaina Bypass"), "MPD Event Chronology", "416: Got fire on Mauka side of byp...100-150 yds from Kai Hele Ku"),
    ("2023-08-08 18:01", ("street", "Pu'unoa Place"), "MPD Event Chronology", "Text 911- Puunoa, house on fire, not sure what address."),
]


def norm(name: str) -> str:
    """OSM mixes spellings (Waine'e / Wainee); compare without okina, apostrophes or case."""
    for ch in "'ʻ‘’`":
        name = name.replace(ch, "")
    return " ".join(name.lower().split())


def _utm(geom):
    return transform(lambda x, y, z=None: to_utm(x, y), geom)


def load_osm(path: Path):
    roads: dict[str, list[LineString]] = {}
    pois: dict[str, list] = {}
    for e in json.loads(path.read_text(encoding="utf-8"))["elements"]:
        tags = e.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        if e["type"] == "node":
            geom = Point(e["lon"], e["lat"])
        elif "geometry" in e:
            coords = [(p["lon"], p["lat"]) for p in e["geometry"]]
            if len(coords) < 2:
                continue
            closed = coords[0] == coords[-1] and len(coords) >= 4
            geom = Polygon(coords) if closed and "highway" not in tags else LineString(coords)
        elif "bounds" in e:
            b = e["bounds"]
            geom = Point((b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2)
        else:
            continue
        geom = _utm(geom)
        if "highway" in tags:
            roads.setdefault(norm(name), []).append(geom)
        else:
            pois.setdefault(norm(name), []).append(geom)
    return roads, pois


def resolve(spec, roads, pois) -> tuple[float, float, float, str]:
    """Returns (easting, northing, precision_m, method)."""
    kind = spec[0]
    if kind == "coord":
        e, n = to_utm(spec[2], spec[1])
        return e, n, 30.0, "FSRI-provided coordinates"
    if kind == "poi":
        geoms = pois[norm(spec[1])]
        c = unary_union(geoms).centroid
        return c.x, c.y, 40.0, f"OSM landmark '{spec[1]}'"
    line = linemerge(MultiLineString([g for g in roads[norm(spec[1])]]))
    if kind == "street":
        p = line.interpolate(0.5, normalized=True)
        return p.x, p.y, max(50.0, line.length / 2), f"OSM road '{spec[1]}' midpoint ({line.length:.0f} m long)"
    if kind == "street_end":
        # The dead end: the endpoint farthest from any other named road.
        others = unary_union([g for name, gs in roads.items() if name != norm(spec[1]) for g in gs])
        ends = []
        for part in getattr(line, "geoms", [line]):
            ends += [Point(part.coords[0]), Point(part.coords[-1])]
        end = max(ends, key=lambda p: others.distance(p))
        return end.x, end.y, 30.0, f"OSM road '{spec[1]}' dead end"
    if kind == "x":
        a = unary_union(roads[norm(spec[1])])
        b = unary_union(roads[norm(spec[2])])
        inter = a.intersection(b)
        if not inter.is_empty:
            c = inter.centroid
            return c.x, c.y, 25.0, f"OSM intersection {spec[1]} x {spec[2]}"
        pa, pb = nearest_points(a, b)
        gap = pa.distance(pb)
        if gap > 60:
            raise ValueError(f"{spec[1]} and {spec[2]} do not meet (gap {gap:.0f} m)")
        return (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 25.0 + gap, f"OSM near-intersection {spec[1]} x {spec[2]} (gap {gap:.0f} m)"
    raise ValueError(spec)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    roads, pois = load_osm(RAW_DIR / "osm_lahaina.json")
    rows = []
    for i, (time, spec, source, quote) in enumerate(SIGHTINGS):
        e, n, precision, method = resolve(spec, roads, pois)
        lon, lat = from_utm(e, n)
        rows.append({
            "id": f"A{i:02d}", "time_hst": time, "lat": f"{lat:.6f}", "lon": f"{lon:.6f}",
            "precision_m": f"{precision:.0f}", "method": method, "fsri_source": source, "quote": quote,
        })
        print(f"A{i:02d} {time} {lat:.5f} {lon:.5f} ±{precision:4.0f} m  {method}")
    ANCHORS_CSV.parent.mkdir(parents=True, exist_ok=True)
    with ANCHORS_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} anchors to {ANCHORS_CSV}")


if __name__ == "__main__":
    main()
