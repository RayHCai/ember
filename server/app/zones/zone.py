"""A watch zone: its grid, map data, shelters and edge servers."""

from __future__ import annotations

import math
import re
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field

from .. import config
from ..geo.core import LatLon, LocalProjection, polygon_area_km2
from ..geo.grid import ZoneGrid
from ..geo.osm import OsmData, Place
from .edge import CoverageModel, EdgeServer


def new_zone_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "zone"
    return f"{slug}-{uuid.uuid4().hex[:6]}"


def fill_elevation(grid: ZoneGrid, samples: Sequence[Sequence[float]]) -> list[float] | None:
    """Nearest-sample elevation for every cell, from [lat, lon, height] samples."""
    if not samples:
        return None
    proj = LocalProjection((grid.south, grid.west))
    bucket = 400.0
    index: dict[tuple[int, int], list[tuple[float, float, float]]] = defaultdict(list)
    for lat, lon, h in samples:
        x, y = proj.to_xy((lat, lon))
        index[(int(x // bucket), int(y // bucket))].append((x, y, h))
    heights: list[float] = []
    for i in range(grid.size):
        x, y = proj.to_xy(grid.center(i))
        bx, by = int(x // bucket), int(y // bucket)
        best, best_h = math.inf, 0.0
        for reach in range(1, 6):
            for a in range(bx - reach, bx + reach + 1):
                for b in range(by - reach, by + reach + 1):
                    for sx, sy, h in index.get((a, b), ()):
                        d = (sx - x) ** 2 + (sy - y) ** 2
                        if d < best:
                            best, best_h = d, h
            if best < math.inf:
                break
        heights.append(best_h)
    return heights


@dataclass
class Shelter:
    id: str
    name: str
    lat: float
    lon: float
    kind: str

    @classmethod
    def from_place(cls, p: Place) -> "Shelter":
        return cls(p.id, p.name, p.lat, p.lon, p.kind)


@dataclass
class Zone:
    id: str
    name: str
    polygon: list[LatLon]
    grid: ZoneGrid
    osm: OsmData
    shelters: list[Shelter]
    elevation: list[float] | None = None
    servers: list[EdgeServer] = field(default_factory=list)
    coverage_pct: float = 0.0
    _coverage: CoverageModel | None = field(default=None, repr=False)

    @property
    def area_km2(self) -> float:
        return round(polygon_area_km2(self.polygon), 3)

    @property
    def coverage(self) -> CoverageModel:
        if self._coverage is None:
            self._coverage = CoverageModel(self.grid, self.polygon)
        return self._coverage

    @property
    def deployed(self) -> list[EdgeServer]:
        return [s for s in self.servers if s.status == "deployed"]

    def zone_payload(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "polygon": [list(p) for p in self.polygon],
            "area_km2": self.area_km2,
        }

    def map_payload(self) -> dict:
        return {
            **self.osm.to_payload(),
            "shelters": [asdict(s) for s in self.shelters],
            "grid": self.grid.to_payload(),
            "elevation": "terrain" if self.elevation else "flat",
        }

    def edge_payload(self) -> dict:
        return {"servers": [s.to_payload() for s in self.servers], "coverage_pct": self.coverage_pct}


def build_zone(
    name: str,
    polygon: Sequence[LatLon],
    osm: OsmData,
    shelters: Sequence[Place],
    elevation_samples: Sequence[Sequence[float]] | None = None,
    zone_id: str | None = None,
) -> Zone:
    grid = ZoneGrid.from_polygon(polygon, config.GRID_CELL_M)
    return Zone(
        id=zone_id or new_zone_id(name),
        name=name,
        polygon=[tuple(p) for p in polygon],
        grid=grid,
        osm=osm,
        shelters=[Shelter.from_place(p) for p in shelters],
        elevation=fill_elevation(grid, elevation_samples or []),
    )
