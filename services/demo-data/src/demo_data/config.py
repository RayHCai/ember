"""Static configuration: data paths, the area of interest, the event timeline and imagery layers.

All coordinates are WGS84 (EPSG:4326) longitude/latitude in degrees. Western-hemisphere
longitudes are negative. All scenario times are timezone-aware; Hawaii (HST) is UTC-10
with no daylight saving.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

HST = timezone(timedelta(hours=-10), "HST")


def hst(y: int, mo: int, d: int, h: int = 0, mi: int = 0, s: int = 0) -> datetime:
    return datetime(y, mo, d, h, mi, s, tzinfo=HST)


# --- Paths -------------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[4]
DATA_DIR = Path(os.environ.get("EMBER_DATA_DIR", _REPO_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
TILES_DIR = DATA_DIR / "tiles"
DERIVED_DIR = DATA_DIR / "derived"
VERIFY_DIR = DATA_DIR / "verify"
PACKAGE_DIR = Path(__file__).resolve().parent
ANCHORS_CSV = PACKAGE_DIR / "scenario" / "anchors.csv"

USER_AGENT = "ember-demo-data/0.1 (wildfire research demo)"


# --- Area of interest ----------------------------------------------------------------------


@dataclass(frozen=True)
class BBox:
    west: float
    south: float
    east: float
    north: float

    def contains(self, lon: float, lat: float) -> bool:
        return self.west <= lon <= self.east and self.south <= lat <= self.north

    def intersect(self, other: "BBox") -> "BBox":
        return BBox(
            max(self.west, other.west),
            max(self.south, other.south),
            min(self.east, other.east),
            min(self.north, other.north),
        )

    def as_list(self) -> list[float]:
        return [self.west, self.south, self.east, self.north]


# The official (WFIGS) Lahaina fire perimeter spans lon -156.6878..-156.6471,
# lat 20.8443..20.9085. The AOI adds ~600 m on every side.
AOI = BBox(west=-156.695, south=20.838, east=-156.640, north=20.915)

# UTM zone 4N: the native grid of Sentinel-2 tile 04QGJ, used for all analysis rasters.
UTM_EPSG = 32604
GRID_RES_M = 10.0

# Rekindle origin: end of the Kuʻialua St cul-de-sac (FSRI timeline 14:55, "Numerous callers.
# At the end of the cul de sac of Kuʻialua"). The dead end of Kuialua Street in OpenStreetMap (anchor A00).
ORIGIN_LON, ORIGIN_LAT = -156.66411, 20.88394


# --- Event timeline (HST) ------------------------------------------------------------------

SCENARIO_START = hst(2023, 8, 8, 0, 0)
SCENARIO_END = hst(2023, 8, 31, 0, 0)
MORNING_IGNITION = hst(2023, 8, 8, 6, 34)  # ATF/MFD origin & cause report
MORNING_CONTAINED = hst(2023, 8, 8, 9, 0)
REKINDLE = hst(2023, 8, 8, 14, 52)  # ATF/MFD; first 911 calls 14:55
DEFAULT_CLOCK_START = hst(2023, 8, 8, 14, 30)

KEY_EVENTS = [
    (hst(2023, 8, 8, 6, 34), "Morning fire ignites near Lahainaluna Rd (ATF/MFD report)"),
    (hst(2023, 8, 8, 9, 0), "Morning fire declared contained"),
    (hst(2023, 8, 8, 11, 9), "Sentinel-2 pass: last clear pre-fire satellite image (10 m)"),
    (hst(2023, 8, 8, 14, 52), "Rekindle at the end of Kuʻialua St (ATF/MFD report)"),
    (hst(2023, 8, 8, 15, 21), "GOES-18 first detects the Lahaina fire"),
    (hst(2023, 8, 8, 15, 22), "Fire jumps the Lahaina Bypass headed west (FSRI)"),
    (hst(2023, 8, 8, 16, 24), "Banyan tree reported on fire; fire headed to Front St (FSRI)"),
    (hst(2023, 8, 8, 16, 46), "GOES-18 peak fire radiative power over Lahaina"),
    (hst(2023, 8, 8, 19, 0), "Front St engulfed from Shaw St to Mala (FSRI)"),
    (hst(2023, 8, 8, 22, 25), "Landsat 8 night pass shows the town burning (30 m SWIR)"),
    (hst(2023, 8, 9, 6, 30), "Last FSRI fire-front reports (south end, Kai Hele Ku / Haniu)"),
    (hst(2023, 8, 9, 11, 20), "Maxar WorldView-2: first sub-meter image after the fire"),
    (hst(2023, 8, 12, 11, 12), "Maxar WorldView-2: clear post-fire image"),
    (hst(2023, 8, 14, 12, 0), "WaldoAir 10 cm aerial survey (time of day unknown)"),
]


# --- Imagery layers ------------------------------------------------------------------------


@dataclass(frozen=True)
class Layer:
    id: str
    title: str
    url: str  # {z} {x} {y} placeholders; XYZ (Google) tile scheme
    min_zoom: int
    max_zoom: int
    captured: datetime
    capture_note: str
    resolution: str
    license: str
    attribution: str
    bounds: BBox = AOI
    # NOAA answers a missing tile with a 302 to a blank image; Esri redirects to real
    # tiles shared across Wayback releases.
    redirect_is_missing: bool = False

    @property
    def path(self) -> Path:
        return TILES_DIR / f"{self.id}.mbtiles"


LAYERS: dict[str, Layer] = {
    layer.id: layer
    for layer in [
        Layer(
            id="pre_2020",
            title="Esri World Imagery Wayback, release 2023-06-29 (pre-fire)",
            # Esri's ArcGIS tile path is row-major: .../{z}/{row}/{col} == {z}/{y}/{x}.
            url="https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/47963/{z}/{y}/{x}",
            min_zoom=13,
            max_zoom=18,
            captured=hst(2020, 2, 20, 11, 0),
            capture_note="Maxar WorldView-2 capture 2020-02-20 (Esri metadata); time of day approximate",
            resolution="0.5 m",
            license="Esri Master License Agreement / Terms of Use",
            attribution="Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        ),
        Layer(
            id="maxar_20230809",
            title="Maxar WorldView-2, 2023-08-09 11:20 HST (smoldering, smoke plumes)",
            url="https://stormscdn.ngs.noaa.gov/20230809a-rgb/{z}/{x}/{y}",
            min_zoom=13,
            max_zoom=18,
            captured=hst(2023, 8, 9, 11, 20, 30),
            capture_note="Catalog 10300100EB592000, 38 deg off-nadir",
            resolution="0.74 m",
            license="CC BY-NC 4.0",
            attribution="Maxar Open Data Program, via NOAA NGS",
            redirect_is_missing=True,
        ),
        Layer(
            id="maxar_20230812",
            title="Maxar WorldView-2, 2023-08-12 11:12 HST (clear, post-fire)",
            url="https://stormscdn.ngs.noaa.gov/20230812a-rgb/{z}/{x}/{y}",
            min_zoom=13,
            max_zoom=18,
            captured=hst(2023, 8, 12, 11, 12, 48),
            capture_note="Catalog 10300100EB15FF00, 21 deg off-nadir, 0% cloud",
            resolution="0.52 m",
            license="CC BY-NC 4.0",
            attribution="Maxar Open Data Program, via NOAA NGS",
            redirect_is_missing=True,
        ),
        Layer(
            id="waldo_20230814",
            title="WaldoAir aerial survey, 2023-08-14 (post-fire)",
            url="https://stormscdn.ngs.noaa.gov/20230814a-rgb/{z}/{x}/{y}",
            min_zoom=13,
            max_zoom=19,
            captured=hst(2023, 8, 14, 12, 0),
            capture_note="Flight time of day not published; 12:00 HST assumed",
            resolution="0.10 m",
            license="Not stated (released publicly via NOAA NGS); verify before redistribution",
            attribution="WaldoAir, via NOAA NGS Emergency Response Imagery",
            redirect_is_missing=True,
            bounds=BBox(west=-156.6886, south=20.8542, east=-156.6527, north=20.9045),
        ),
    ]
}


# --- Weather / satellite reference sources -------------------------------------------------

WEATHER_STATION = {
    "id": "PHOG",
    "name": "Kahului Airport ASOS",
    "lat": 20.8889,
    "lon": -156.4344,
    "note": "Nearest station with Aug 8 2023 records (~25 km east of Lahaina, windward side). "
    "Kapalua (PHJH) has no archived data for the event.",
}

# Downslope winds over the West Maui Mountains drove the fire from the east-northeast
# toward the ocean (FSRI: "Kuʻialua heading west towards the Bypass").
FIRE_WIND_FROM_DEG = 75.0
