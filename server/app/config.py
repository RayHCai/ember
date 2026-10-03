"""Server settings and simulation assumptions.

Every hardware number here is an ASSUMPTION for the simulation, not a
measured spec. Change them here and nowhere else.
"""

from __future__ import annotations

import os
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent

# Writable data folder. The bundled desktop app sets EMBER_DATA_DIR to its
# app data folder; in development everything lives under server/.
DATA_DIR = Path(os.environ.get("EMBER_DATA_DIR") or SERVER_DIR)
CACHE_DIR = DATA_DIR / "cache"

# Cached OpenStreetMap responses that ship with the repo (demo presets).
BUNDLED_CACHE_DIR = SERVER_DIR / "cache"

# --- Zones -------------------------------------------------------------------

# Skip the Overpass API and use cached OpenStreetMap data or the synthetic road
# grid. For demos on bad Wi-Fi and for tests.
OSM_OFFLINE = os.environ.get("EMBER_OSM_OFFLINE", "").strip() in ("1", "true", "yes")

GRID_CELL_M = 100.0  # grid cell size
MAX_ZONE_AREA_KM2 = 400.0  # keeps the grid under about 40,000 cells
OSM_MARGIN_M = 2000.0  # roads and communities are fetched this far past the zone
SHELTER_SEARCH_MARGIN_M = 8000.0  # schools and community centres can be further out
SHELTERS_SUGGESTED = 2

# --- Edge servers (drone docks) -----------------------------------------------

EDGE_RADIUS_M = 1500.0  # ASSUMPTION: useful radio and flight radius of one dock
EDGE_CANDIDATE_SPACING_M = 250.0
EDGE_ROAD_ACCESS_M = 200.0  # docks this close to a road count as maintainable
EDGE_OFF_ROAD_WEIGHT = 0.75  # off-road candidates score lower, not zero
EDGE_TARGET_COVERAGE = 0.90
EDGE_MAX_SERVERS = 20
