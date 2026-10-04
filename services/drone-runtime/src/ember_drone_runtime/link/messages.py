"""Edge link wire shapes; mirror of packages/contracts/src/droneLink.ts and droneInfo.ts.

Inbound messages are validated here and become dataclasses; outbound ones are built as plain dicts
in the wire's camelCase.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, cast

from ..camera import CameraSpec, Pose
from ..geo import LatLng
from ..perception.georef import RiskDetection

DRONE_LINK_PATH = "/v1/drone"
# Mirrors EDGE_SERVICE_TYPE in droneLink.ts; TXT records `id` and `path`.
EDGE_SERVICE_TYPE = "_ember-edge._tcp"
# Mirrors DRONE_INFO_INGEST_PATH in droneInfo.ts; what edge-manager posts reports to.
DRONE_INFO_INGEST_PATH = "/v1/ingest"

Phase = Literal["takeoff", "mapping", "returning", "landing", "landed"]
DroneMode = Literal["idle", "patrol", "returning", "landed"]
PHASES: tuple[Phase, ...] = ("takeoff", "mapping", "returning", "landing", "landed")

Json = dict[str, object]
Vec3 = tuple[float, float, float]


class LinkError(ValueError):
    """A message on the edge link that does not match the contract."""


@dataclass(frozen=True)
class Mission:
    run_id: str
    zone_id: str
    edge_server: LatLng
    connectivity_radius_m: float
    boundary: tuple[LatLng, ...] | None
    cell_size_m: float
    alt_min_m: float
    alt_max_m: float
    swarm: tuple[str, ...]


@dataclass(frozen=True)
class Welcome:
    edge_server_id: str


@dataclass(frozen=True)
class StartMapping:
    mission: Mission


@dataclass(frozen=True)
class StopMapping:
    run_id: str


@dataclass(frozen=True)
class PeerState:
    sent_at: str
    phase: Phase
    position: Vec3
    velocity: Vec3
    goal: tuple[float, float] | None
    battery_pct: float


@dataclass(frozen=True)
class PeerEvidence:
    """Log-odds a drone's own frames added to cells since its last coverage message."""

    cells: tuple[int, ...]
    on_fire: tuple[float, ...]
    at_risk: tuple[float, ...]


@dataclass(frozen=True)
class PeerCoverage:
    cells: tuple[int, ...]
    top_m: tuple[float | None, ...]
    evidence: PeerEvidence | None = None


@dataclass(frozen=True)
class SwarmIn:
    run_id: str
    sender: str
    payload: PeerState | PeerCoverage


Downlink = Welcome | StartMapping | StopMapping | SwarmIn


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_downlink(data: object) -> Downlink:
    msg = _obj(data, "message")
    kind = _str(msg, "type")
    if kind == "welcome":
        return Welcome(_str(msg, "edgeServerId"))
    if kind == "start_mapping":
        return StartMapping(_mission(_obj(msg.get("mission"), "mission")))
    if kind == "stop_mapping":
        return StopMapping(_str(msg, "runId"))
    if kind == "swarm":
        return SwarmIn(
            _str(msg, "runId"), _str(msg, "from"), _payload(_obj(msg.get("payload"), "payload"))
        )
    raise LinkError(f"unknown message type {kind!r}")


def _mission(m: Json) -> Mission:
    alt = _obj(m.get("altitude"), "mission.altitude")
    radius = _num(m, "connectivityRadiusM")
    cell = _num(m, "cellSizeM")
    lo, hi = _num(alt, "minM"), _num(alt, "maxM")
    if radius <= 0 or cell <= 0 or not 0 < lo <= hi:
        raise LinkError(
            f"mission: bad geometry (radius {radius}, cell {cell}, altitude {lo}..{hi})"
        )
    if radius / cell > 2000:
        raise LinkError(f"mission: {radius} m radius at {cell} m cells is too fine a grid")
    swarm = m.get("swarm")
    if not isinstance(swarm, list) or not all(isinstance(d, str) for d in swarm):
        raise LinkError("mission.swarm must be a list of drone ids")
    boundary = m.get("boundary")
    ring: tuple[LatLng, ...] | None = None
    if boundary is not None:
        if not isinstance(boundary, list) or len(boundary) < 3:
            raise LinkError("mission.boundary must be null or at least 3 points")
        ring = tuple(_latlng(p, "mission.boundary[]") for p in boundary)
    return Mission(
        run_id=_str(m, "runId"),
        zone_id=_str(m, "zoneId"),
        edge_server=_latlng(m.get("edgeServer"), "mission.edgeServer"),
        connectivity_radius_m=radius,
        boundary=ring,
        cell_size_m=cell,
        alt_min_m=lo,
        alt_max_m=hi,
        swarm=tuple(cast(list[str], swarm)),
    )


def _payload(p: Json) -> PeerState | PeerCoverage:
    kind = _str(p, "kind")
    if kind == "state":
        phase = _str(p, "phase")
        if phase not in PHASES:
            raise LinkError(f"swarm state: unknown phase {phase!r}")
        goal = p.get("goal")
        g = None
        if goal is not None:
            go = _obj(goal, "swarm state goal")
            g = (_num(go, "eastM"), _num(go, "northM"))
        return PeerState(
            sent_at=_str(p, "sentAt"),
            phase=phase,
            position=_vec3(p.get("position"), "position"),
            velocity=_vec3(p.get("velocity"), "velocity"),
            goal=g,
            battery_pct=_num(p, "batteryPct"),
        )
    if kind == "coverage":
        cells, tops = p.get("cells"), p.get("topM")
        if not isinstance(cells, list) or not isinstance(tops, list) or len(cells) != len(tops):
            raise LinkError("swarm coverage: cells and topM must be lists of equal length")
        if not all(isinstance(c, int) and not isinstance(c, bool) for c in cells):
            raise LinkError("swarm coverage: cells must be integers")
        if not all(t is None or _finite(t) for t in tops):
            raise LinkError("swarm coverage: topM must be numbers or null")
        return PeerCoverage(
            tuple(cast(list[int], cells)),
            tuple(None if t is None else float(cast(float, t)) for t in tops),
            None if p.get("evidence") is None else _evidence(p["evidence"]),
        )
    raise LinkError(f"unknown swarm payload kind {kind!r}")


def _evidence(value: object) -> PeerEvidence:
    e = _obj(value, "swarm coverage evidence")
    cells, on_fire, at_risk = e.get("cells"), e.get("onFire"), e.get("atRisk")
    if not (
        isinstance(cells, list)
        and isinstance(on_fire, list)
        and isinstance(at_risk, list)
        and len(cells) == len(on_fire) == len(at_risk)
    ):
        raise LinkError("swarm coverage evidence: cells, onFire and atRisk must be equal lists")
    if not all(isinstance(c, int) and not isinstance(c, bool) for c in cells):
        raise LinkError("swarm coverage evidence: cells must be integers")
    if not all(_finite(v) for v in (*on_fire, *at_risk)):
        raise LinkError("swarm coverage evidence: onFire and atRisk must be numbers")
    return PeerEvidence(
        tuple(cast(list[int], cells)),
        tuple(float(cast(float, v)) for v in on_fire),
        tuple(float(cast(float, v)) for v in at_risk),
    )


def hello(
    drone_id: str,
    name: str,
    kind: Literal["simulated", "physical"],
    camera: CameraSpec,
    sensors: list[str],
    max_speed_mps: float,
    endurance_s: float,
) -> Json:
    return {
        "type": "hello",
        "droneId": drone_id,
        "name": name,
        "kind": kind,
        "camera": camera_wire(camera),
        "sensors": sensors,
        "maxSpeedMps": max_speed_mps,
        "enduranceS": endurance_s,
    }


def telemetry(
    drone_id: str,
    scenario_time: str | None,
    scenario_speed: float,
    pose: Pose,
    camera: CameraSpec,
    velocity: Vec3,
    battery_pct: float,
    mode: DroneMode,
) -> Json:
    return {
        "type": "telemetry",
        "droneId": drone_id,
        "sentAt": now_iso(),
        "scenarioTime": scenario_time,
        "scenarioSpeed": scenario_speed,
        "pose": pose_wire(pose),
        "camera": camera_wire(camera),
        "velocity": {
            "eastMps": round(velocity[0], 2),
            "northMps": round(velocity[1], 2),
            "upMps": round(velocity[2], 2),
        },
        "batteryPct": round(battery_pct, 1),
        "mode": mode,
    }


def detections(
    drone_id: str,
    frame_id: int,
    captured_at: str,
    scenario_time: str,
    pose: Pose,
    camera: CameraSpec,
    detector: str,
    found: list[RiskDetection],
) -> Json:
    return {
        "type": "detections",
        "droneId": drone_id,
        "frameId": frame_id,
        "capturedAt": captured_at,
        "scenarioTime": scenario_time,
        "pose": pose_wire(pose),
        "camera": camera_wire(camera),
        "detector": detector,
        "detections": [detection_wire(d) for d in found],
    }


def mission_status(
    drone_id: str, run_id: str, phase: Phase, coverage: float, detection_count: int
) -> Json:
    return {
        "type": "mission_status",
        "droneId": drone_id,
        "runId": run_id,
        "phase": phase,
        "coverage": round(coverage, 4),
        "detections": detection_count,
    }


def swarm_state(run_id: str, drone_id: str, state: PeerState) -> Json:
    goal = None if state.goal is None else {"eastM": state.goal[0], "northM": state.goal[1]}
    payload: Json = {
        "kind": "state",
        "sentAt": state.sent_at,
        "phase": state.phase,
        "position": _vec3_wire(state.position),
        "velocity": _vec3_wire(state.velocity),
        "goal": goal,
        "batteryPct": round(state.battery_pct, 1),
    }
    return {"type": "swarm", "runId": run_id, "from": drone_id, "payload": payload}


def swarm_coverage(run_id: str, drone_id: str, coverage: PeerCoverage) -> Json:
    payload: Json = {
        "kind": "coverage",
        "cells": list(coverage.cells),
        "topM": list(coverage.top_m),
    }
    if coverage.evidence is not None:
        payload["evidence"] = {
            "cells": list(coverage.evidence.cells),
            "onFire": list(coverage.evidence.on_fire),
            "atRisk": list(coverage.evidence.at_risk),
        }
    return {"type": "swarm", "runId": run_id, "from": drone_id, "payload": payload}


def camera_wire(c: CameraSpec) -> Json:
    return {"widthPx": c.width_px, "heightPx": c.height_px, "hfovDeg": c.hfov_deg}


def pose_wire(p: Pose) -> Json:
    return {
        "lat": round(p.lat, 7),
        "lng": round(p.lng, 7),
        "altM": round(p.alt_m, 2),
        "headingDeg": round(p.heading_deg % 360.0, 2),
        "pitchDeg": round(p.pitch_deg, 2),
    }


def detection_wire(d: RiskDetection) -> Json:
    out: Json = {
        "id": d.id,
        "risk": d.risk,
        "confidence": round(d.confidence, 3),
        "bboxPx": [round(v, 1) for v in d.bbox_px],
        "ground": [{"lat": round(p.lat, 7), "lng": round(p.lng, 7)} for p in d.ground],
        "center": {"lat": round(d.center.lat, 7), "lng": round(d.center.lng, 7)},
        "areaM2": round(d.area_m2, 1),
    }
    if d.peak_temp_k is not None:
        out["peakTempK"] = round(d.peak_temp_k, 1)
    return out


def _vec3_wire(v: Vec3) -> Json:
    return {"eastM": round(v[0], 2), "northM": round(v[1], 2), "upM": round(v[2], 2)}


def _obj(value: object, where: str) -> Json:
    if not isinstance(value, dict):
        raise LinkError(f"{where} must be an object")
    return cast(Json, value)


def _str(m: Json, key: str) -> str:
    v = m.get(key)
    if not isinstance(v, str) or not v:
        raise LinkError(f"{key} must be a non-empty string")
    return v


def _finite(v: object) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _num(m: Json, key: str) -> float:
    v = m.get(key)
    if not _finite(v):
        raise LinkError(f"{key} must be a finite number")
    return float(cast(float, v))


def _latlng(value: object, where: str) -> LatLng:
    m = _obj(value, where)
    lat, lng = _num(m, "lat"), _num(m, "lng")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise LinkError(f"{where}: lat {lat}, lng {lng} out of range")
    return LatLng(lat, lng)


def _vec3(value: object, where: str) -> Vec3:
    m = _obj(value, where)
    return (_num(m, "eastM"), _num(m, "northM"), _num(m, "upM"))
