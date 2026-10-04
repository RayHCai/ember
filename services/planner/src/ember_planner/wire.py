"""Planner wire shapes; mirror of packages/contracts/src/planner.ts.

Models validate inbound JSON (queue messages, api context, worker results) and dump camelCase.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

PLANNER_QUEUE_KEY = "ember:planner:jobs"
PLANNER_PROCESSING_KEY = "ember:planner:processing"
PLANNER_CELERY_QUEUE = "planner"
PLANNER_CELERY_TASK = "ember_planner.plan"
PLANNER_CONTEXT_PATH = "/v1/watch-zones/:zoneId/planner-context"
PLANNER_STATUS_PATH = "/v1/planner/jobs/:jobId/status"
PLANNER_RESULT_PATH = "/v1/planner/jobs/:jobId/result"

FuelType = Literal["none", "grass", "shrub", "timber", "urban"]
RoadKind = Literal["motorway", "primary", "secondary", "residential", "track"]
RoadState = Literal["open", "blocked", "uncertain"]
RiskBand = Literal["low", "moderate", "high", "extreme"]
ActiveRisk = Literal["at_risk", "on_fire"]
JobState = Literal["gathering", "planning", "failed"]
ImpactSeverity = Literal["immediate", "warning", "watch", "clear"]

Json = dict[str, object]


class Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, frozen=True, extra="ignore"
    )

    def to_json(self) -> Json:
        return self.model_dump(mode="json", by_alias=True)


class LatLng(Wire):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


Ring = list[LatLng]


class PlannerOptions(Wire):
    horizon_min: float = Field(default=180, gt=0, le=24 * 60)
    band_min: float = Field(default=30, gt=0)
    attack_zone_count: int = Field(default=5, ge=0, le=50)
    evacuation_delay_min: float = Field(default=10, ge=0)
    safety_margin_min: float = Field(default=15, ge=0)
    sector_size_m: float = Field(default=1000, gt=0)


class PlannerJobRequest(Wire):
    job_id: str = Field(min_length=1)
    zone_id: str = Field(min_length=1)
    requested_at: datetime
    requested_by: str
    options: PlannerOptions = Field(default_factory=PlannerOptions)


class GridSpec(Wire):
    south_west: LatLng
    cell_size_m: float = Field(gt=0)
    cols: int = Field(gt=0)
    rows: int = Field(gt=0)


class TerrainGrid(GridSpec):
    elevation_m: list[float | None] | None
    fuel: list[FuelType] | None

    @model_validator(mode="after")
    def _layers_fit(self) -> TerrainGrid:
        n = self.cols * self.rows
        for name, layer in (("elevationM", self.elevation_m), ("fuel", self.fuel)):
            if layer is not None and len(layer) != n:
                raise ValueError(f"terrain.{name}: {len(layer)} values for {n} cells")
        return self


class Weather(Wire):
    observed_at: datetime
    wind_speed_mps: float = Field(ge=0)
    wind_from_deg: float
    temperature_c: float | None
    relative_humidity_pct: float | None = Field(ge=0, le=100)
    wind_gust_mps: float | None = Field(default=None, ge=0)
    red_flag_warning: bool | None = None
    source: str = "unknown"


class PlannerRiskZone(Wire):
    id: str
    risk: ActiveRisk
    polygon: Ring = Field(min_length=3)
    confidence: float = Field(ge=0, le=1)
    observed_at: datetime


class PlannerDetection(Wire):
    id: str
    risk: ActiveRisk
    confidence: float = Field(ge=0, le=1)
    bbox_px: tuple[float, float, float, float]
    ground: Ring
    center: LatLng
    peak_temp_k: float | None = None
    drone_id: str
    captured_at: datetime


class CivilianArea(Wire):
    id: str
    name: str
    center: LatLng
    polygon: Ring | None
    population: float = Field(ge=0)


class Road(Wire):
    id: str
    name: str | None
    kind: RoadKind
    path: Ring = Field(min_length=2)
    state: RoadState = "open"


class SafeZone(Wire):
    id: str
    name: str
    location: LatLng
    capacity: float | None


class ResponderStation(Wire):
    id: str
    name: str
    location: LatLng


class PlannerContext(Wire):
    zone_id: str
    name: str
    boundary: Ring = Field(min_length=3)
    generated_at: datetime
    weather: Weather | None
    terrain: TerrainGrid | None
    risk_zones: list[PlannerRiskZone]
    detections: list[PlannerDetection]
    civilian_areas: list[CivilianArea]
    roads: list[Road]
    safe_zones: list[SafeZone]
    stations: list[ResponderStation]


class PlannerJobStatusUpdate(Wire):
    job_id: str
    zone_id: str
    state: JobState
    at: datetime
    message: str | None


class PolygonShape(Wire):
    outer: Ring
    holes: list[Ring]


class FireIsochrone(Wire):
    at_min: float
    area_ha: float
    polygons: list[PolygonShape]


class TrackPoint(Wire):
    at_min: float
    center: LatLng
    area_ha: float


class FireSpreadForecast(Wire):
    grid: GridSpec
    arrival_min: list[float | None]
    isochrones: list[FireIsochrone]
    track: list[TrackPoint]
    heading_deg: float | None
    max_spread_mpm: float


class AttackApproach(Wire):
    station_id: str
    path: Ring
    road_ids: list[str]
    eta_min: float
    arrives_from_deg: float | None


class AttackZone(Wire):
    id: str
    rank: int
    center: LatLng
    radius_m: float
    drop_site: LatLng
    score: float
    fire_arrival_min: float
    access_min: float | None
    spread_rate_mpm: float
    tactic: Literal["direct", "indirect"]
    protects: list[str]
    protected_population: float
    protected_area_ha: float
    approach: AttackApproach | None = None


class CivilianImpact(Wire):
    civilian_area_id: str
    name: str
    population: float
    impact_min: float | None
    gradient: float
    exposed_fraction: float
    severity: ImpactSeverity


class Destination(Wire):
    safe_zone_id: str | None
    location: LatLng


class EvacuationPath(Wire):
    status: Literal["clear", "tight", "no_safe_route"]
    path: Ring
    destination: Destination | None
    distance_m: float
    eta_min: float
    clearance_min: float | None
    road_ids: list[str] = Field(default_factory=list)


class EvacuationRoute(EvacuationPath):
    civilian_area_id: str
    network: Literal["roads", "terrain"]
    alternate: EvacuationPath | None = None


class SectorFactors(Wire):
    spread_potential: float
    ignition: float
    exposure: float


class SectorRisk(Wire):
    id: str
    number: int
    polygon: Ring
    center: LatLng
    rank: int
    score: float
    band: RiskBand
    factors: SectorFactors
    dominant_fuel: FuelType
    mean_slope_deg: float
    population: float
    fire_arrival_min: float | None
    drivers: list[str]


class PlannerResult(Wire):
    job_id: str
    zone_id: str
    generated_at: datetime
    context_generated_at: datetime
    horizon_min: float
    assumptions: list[str]
    fire_spread: FireSpreadForecast
    attack_zones: list[AttackZone]
    civilian_impacts: list[CivilianImpact]
    evacuation_routes: list[EvacuationRoute]
    sector_risks: list[SectorRisk] = Field(default_factory=list)
