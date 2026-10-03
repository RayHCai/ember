import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import config
from ..geo.core import is_simple_polygon, polygon_area_km2
from ..geo.osm import load_osm, suggest_shelters
from ..runtime import Runtime
from ..zones.edge import EdgeServer, plan_edge_servers
from ..zones.zone import Shelter, Zone, build_zone
from .deps import get_runtime

router = APIRouter(prefix="/zones", tags=["zones"])


class ZoneBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    polygon: list[tuple[float, float]] = Field(min_length=3)
    # Optional terrain samples from the web app: [lat, lon, height_m].
    elevation: list[tuple[float, float, float]] | None = None


class EdgePlanBody(BaseModel):
    radius_m: float = Field(default=config.EDGE_RADIUS_M, gt=100, le=10_000)
    max_servers: int = Field(default=config.EDGE_MAX_SERVERS, ge=1, le=60)


class ServerIn(BaseModel):
    id: str | None = None
    lat: float
    lon: float
    radius_m: float = Field(default=config.EDGE_RADIUS_M, gt=100, le=10_000)


class ServersBody(BaseModel):
    servers: list[ServerIn]
    deploy: bool = True


class ShelterIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    lat: float
    lon: float
    kind: str = "operator"


class SheltersBody(BaseModel):
    shelters: list[ShelterIn]


def get_zone(runtime: Runtime, zone_id: str) -> Zone:
    zone = runtime.zones.get(zone_id)
    if zone is None:
        raise HTTPException(404, f"No zone with id {zone_id}.")
    return zone


@router.get("")
def list_zones(runtime: Runtime = Depends(get_runtime)) -> list[dict]:
    return [z.zone_payload() for z in runtime.zones.values()]


@router.post("", status_code=201)
async def create_zone(body: ZoneBody, runtime: Runtime = Depends(get_runtime)) -> dict:
    polygon = [(lat, lon) for lat, lon in body.polygon]
    if polygon[0] == polygon[-1]:
        polygon = polygon[:-1]
    if len(polygon) < 3:
        raise HTTPException(400, "A zone needs at least 3 points.")
    if not is_simple_polygon(polygon):
        raise HTTPException(400, "The zone outline crosses itself. Move a point so the edges do not cross.")
    area = polygon_area_km2(polygon)
    if area > config.MAX_ZONE_AREA_KM2:
        raise HTTPException(400, f"The zone is {area:.0f} km2. Keep it under {config.MAX_ZONE_AREA_KM2:.0f} km2.")
    if area < 0.05:
        raise HTTPException(400, "The zone is too small. Draw at least a few hundred metres across.")

    osm = await asyncio.to_thread(load_osm, polygon)
    shelters = suggest_shelters(polygon, osm.amenities, config.SHELTERS_SUGGESTED)
    zone = await asyncio.to_thread(build_zone, body.name.strip(), polygon, osm, shelters, body.elevation)
    runtime.add_zone(zone)

    bus = runtime.bus
    bus.emit("zone", zone.id, zone.zone_payload())
    bus.emit("zone_map", zone.id, zone.map_payload())
    if osm.source == "synthetic":
        bus.emit("log", zone.id, {"message": osm.note, "level": "warn", "source": "server"})
    else:
        source = "cache" if osm.source == "cache" else "OpenStreetMap"
        bus.emit("log", zone.id, {
            "message": f"Zone {zone.name} saved: {zone.area_km2:.1f} km2, {len(osm.roads)} roads and "
                       f"{len(osm.communities)} communities from {source}.",
            "source": "server",
        })
    if not zone.elevation:
        bus.emit("log", zone.id, {
            "message": "No terrain heights for this zone (the map has no terrain). Slope uses flat ground.",
            "level": "warn",
            "source": "server",
        })
    if not zone.shelters:
        bus.emit("log", zone.id, {
            "message": "No schools or community centres found near the zone. Add shelters by clicking the map.",
            "level": "warn",
            "source": "server",
        })
    return zone.zone_payload()


@router.delete("/{zone_id}")
def delete_zone(zone_id: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    get_zone(runtime, zone_id)
    runtime.remove_zone(zone_id)
    runtime.bus.emit("zone_removed", zone_id, {"id": zone_id})
    return {"ok": True}


@router.post("/{zone_id}/edge-plan")
async def edge_plan(zone_id: str, body: EdgePlanBody | None = None, runtime: Runtime = Depends(get_runtime)) -> dict:
    zone = get_zone(runtime, zone_id)
    body = body or EdgePlanBody()
    servers, pct = await asyncio.to_thread(
        plan_edge_servers,
        zone.grid,
        zone.polygon,
        [r.points for r in zone.osm.roads],
        radius_m=body.radius_m,
        spacing_m=config.EDGE_CANDIDATE_SPACING_M,
        road_access_m=config.EDGE_ROAD_ACCESS_M,
        off_road_weight=config.EDGE_OFF_ROAD_WEIGHT,
        target=config.EDGE_TARGET_COVERAGE,
        max_servers=body.max_servers,
    )
    zone.servers, zone.coverage_pct = servers, pct
    runtime.bus.emit("edge_plan", zone.id, zone.edge_payload())
    off_road = sum(1 for s in servers if not s.near_road)
    note = f" {off_road} sit more than {config.EDGE_ROAD_ACCESS_M:.0f} m from a road." if off_road else ""
    runtime.bus.emit("log", zone.id, {
        "message": f"Suggested {len(servers)} edge servers covering {pct:.1f}% of the zone.{note}",
        "source": "server",
    })
    return zone.edge_payload()


@router.post("/{zone_id}/edge-servers")
def set_edge_servers(zone_id: str, body: ServersBody, runtime: Runtime = Depends(get_runtime)) -> dict:
    zone = get_zone(runtime, zone_id)
    status = "deployed" if body.deploy else "pending"
    used = {s.id for s in body.servers if s.id}
    servers = []
    for i, s in enumerate(body.servers, 1):
        server_id = s.id or next(f"edge-{n}" for n in range(i, i + 1000) if f"edge-{n}" not in used)
        used.add(server_id)
        servers.append(EdgeServer(server_id, s.lat, s.lon, s.radius_m, status))
    zone.servers = servers
    zone.coverage_pct = zone.coverage.coverage_pct(servers)
    runtime.bus.emit("edge_plan", zone.id, zone.edge_payload())
    if body.deploy:
        runtime.bus.emit("log", zone.id, {
            "message": f"Deployed {len(servers)} edge servers. Coverage {zone.coverage_pct:.1f}%.",
            "source": "server",
        })
        runtime.on_servers_deployed(zone)
    return zone.edge_payload()


@router.put("/{zone_id}/shelters")
def set_shelters(zone_id: str, body: SheltersBody, runtime: Runtime = Depends(get_runtime)) -> dict:
    zone = get_zone(runtime, zone_id)
    zone.shelters = [
        Shelter(s.id or f"shelter-{uuid.uuid4().hex[:6]}", s.name, s.lat, s.lon, s.kind) for s in body.shelters
    ]
    runtime.bus.emit("zone_map", zone.id, zone.map_payload())
    return {"shelters": [s.__dict__ for s in zone.shelters]}
