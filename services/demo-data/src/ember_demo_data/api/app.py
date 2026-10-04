"""Demo Data API: what a drone over Lahaina would have seen at a moment in Aug 2023.

Every position is WGS84 lat/lon in degrees. Requests outside the coverage area are rejected
(HTTP 422 / WebSocket error) rather than answered with imagery of somewhere else.
"""

from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import json
import logging
import os
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Annotated, Any

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

from ..config import (
    ANCHORS_CSV,
    AOI,
    HST,
    KEY_EVENTS,
    LAYERS,
    MORNING_IGNITION,
    SCENARIO_END,
    SCENARIO_START,
)
from ..context import satellite_at, structures, weather_at
from ..geo import (
    TILE_SIZE,
    LocationError,
    global_px_to_lonlat,
    ground_resolution_m,
    tile_bounds,
    validate_position,
)
from ..model.state import CLASS_NAMES, scenario
from ..render.camera import Pose
from ..render.compositor import GroundPoints, epoch_for, render_ground
from ..render.observe import Observation, TimeError, observe, validate_time
from ..tiles import TileStore
from . import world
from .clock import from_env

log = logging.getLogger(__name__)

app = FastAPI(
    title="Ember Demo Data",
    version="0.1.0",
    description="Historical Lahaina (Aug 2023) imagery plus a synthesized fire, served as drone "
    "sensor data.",
)
clock = from_env()
# Browsers on this machine and the Tauri webview; EMBER_DEMO_DATA_ORIGINS adds others.
_LOCAL_ORIGINS = (
    r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"
    r"|tauri://localhost|https?://tauri\.localhost)$"
)
_EXTRA_ORIGINS = [
    o.strip() for o in os.environ.get("EMBER_DEMO_DATA_ORIGINS", "").split(",") if o.strip()
]
# The Three.js viewer (a desktop webview or a dev browser tab) reads tiles, frames and world assets.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_EXTRA_ORIGINS,
    allow_origin_regex=_LOCAL_ORIGINS,
    allow_methods=["GET", "PUT"],
    allow_headers=["*"],
    expose_headers=[
        "X-Ember-Scenario-Time",
        "X-Ember-Center",
        "X-Ember-Footprint",
        "X-Ember-Epoch",
        "X-Ember-Extent",
    ],
)
app.include_router(world.router)


@app.exception_handler(LocationError)
async def _location_error(_: Request, exc: LocationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": "out_of_coverage", "message": str(exc)})


@app.exception_handler(TimeError)
async def _time_error(_: Request, exc: TimeError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": "bad_time", "message": str(exc)})


@app.exception_handler(ValueError)
async def _value_error(_: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": "bad_request", "message": str(exc)})


def resolve_time(t: str | None) -> datetime:
    """Explicit ISO 8601 time (must carry a UTC offset) or the scenario clock."""
    if t is None or t == "" or t == "now":
        return clock.now()
    try:
        dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError as err:
        raise TimeError(
            f"could not parse time {t!r}; use ISO 8601 such as 2023-08-08T16:30:00-10:00"
        ) from err
    if dt.tzinfo is None:
        raise TimeError(f"time {t!r} has no UTC offset; add -10:00 for Hawaii time")
    return validate_time(dt)


# --- Scenario and clock ----------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, Any]:
    missing = [layer.id for layer in LAYERS.values() if not layer.path.exists()]
    return {"ok": not missing, "missing_layers": missing}


@app.get("/v1/scenario")
def get_scenario() -> dict[str, Any]:
    return {
        "name": "Lahaina, Maui - August 8-9, 2023",
        "coverage": {
            "bbox": AOI.as_list(),
            "crs": "EPSG:4326",
            "note": "Requests outside this box are rejected.",
        },
        "time_range": [SCENARIO_START.isoformat(), SCENARIO_END.isoformat()],
        "timezone": "HST (UTC-10)",
        "key_events": [{"time": t.isoformat(), "event": e} for t, e in KEY_EVENTS],
        "imagery_layers": [
            {
                "id": layer.id,
                "title": layer.title,
                "captured": layer.captured.isoformat(),
                "capture_note": layer.capture_note,
                "resolution": layer.resolution,
                "license": layer.license,
                "attribution": layer.attribution,
                "max_zoom": layer.max_zoom,
            }
            for layer in LAYERS.values()
        ],
        "synthetic_window": [
            MORNING_IGNITION.isoformat(),
            LAYERS["maxar_20230809"].captured.isoformat(),
        ],
        "classes": CLASS_NAMES,
        "clock": clock.state(),
    }


class ClockUpdate(BaseModel):
    scenario_time: str | None = Field(
        None, description="ISO 8601 with offset, e.g. 2023-08-08T15:00:00-10:00"
    )
    speed: float | None = Field(None, description="scenario seconds per wall-clock second")
    paused: bool | None = None


@app.get("/v1/clock")
def get_clock() -> dict[str, Any]:
    return clock.state()


@app.put("/v1/clock")
def put_clock(update: ClockUpdate) -> dict[str, Any]:
    t = resolve_time(update.scenario_time) if update.scenario_time else None
    clock.set(t, update.speed, update.paused)
    return clock.state()


# --- Observations ----------------------------------------------------------------------------

LatQ = Annotated[float, Query(description="drone latitude, WGS84 degrees")]
LonQ = Annotated[float, Query(description="drone longitude, WGS84 degrees (negative in Hawaii)")]


def _observe(
    lat: float,
    lon: float,
    alt_m: float,
    heading_deg: float,
    pitch_deg: float,
    t: str | None,
    width: int,
    height: int,
    hfov_deg: float,
    thermal_width: int,
    truth: bool,
) -> Observation:
    validate_position(lat, lon)
    when = resolve_time(t)
    return observe(
        Pose(lat, lon, alt_m, heading_deg, pitch_deg),
        when,
        width,
        height,
        hfov_deg,
        thermal_width,
        truth,
    )


@app.get("/v1/observation")
def get_observation(
    lat: LatQ,
    lon: LonQ,
    alt_m: float = 120.0,
    heading_deg: float = 0.0,
    pitch_deg: float = -90.0,
    t: str | None = Query(None, description="ISO 8601 scenario time; default: scenario clock"),
    width: int = 640,
    height: int = 480,
    hfov_deg: float = 84.0,
    thermal_width: int = 320,
    images: str = Query(
        "rgb,thermal", description="comma list of rgb, thermal, labels (labels need truth=true)"
    ),
    truth: bool = False,
) -> dict[str, Any]:
    obs = _observe(
        lat, lon, alt_m, heading_deg, pitch_deg, t, width, height, hfov_deg, thermal_width, truth
    )
    return obs.to_message({s.strip() for s in images.split(",") if s.strip()})


def _frame_headers(obs: Observation) -> dict[str, Any]:
    md = obs.metadata()
    return {
        "X-Ember-Scenario-Time": md["scenario_time"],
        "X-Ember-Center": json.dumps(md["georef"]["center_ground"]),
        "X-Ember-Footprint": json.dumps(md["georef"]["footprint"]["coordinates"][0][::4]),
        "X-Ember-Epoch": md["imagery"]["name"],
        "Cache-Control": "no-store",
    }


@app.get("/v1/frame/{kind}")
def get_frame(
    kind: str,
    lat: LatQ,
    lon: LonQ,
    alt_m: float = 120.0,
    heading_deg: float = 0.0,
    pitch_deg: float = -90.0,
    t: str | None = None,
    width: int = 640,
    height: int = 480,
    hfov_deg: float = 84.0,
    thermal_width: int = 320,
) -> Response:
    """Single image for quick viewing: rgb.jpg, thermal.png (16-bit deci-kelvin),
    thermal_preview.png, labels.png."""
    truth = kind.startswith("labels")
    obs = _observe(
        lat, lon, alt_m, heading_deg, pitch_deg, t, width, height, hfov_deg, thermal_width, truth
    )
    h = _frame_headers(obs)
    if kind == "rgb.jpg":
        return Response(obs.images.rgb_jpeg(), media_type="image/jpeg", headers=h)
    if kind == "thermal.png":
        return Response(obs.images.thermal_png16(), media_type="image/png", headers=h)
    if kind == "thermal_preview.png":
        buf = io.BytesIO()
        obs.images.thermal_preview().save(buf, "PNG")
        return Response(buf.getvalue(), media_type="image/png", headers=h)
    if kind == "labels.png":
        return Response(obs.images.labels_png(), media_type="image/png", headers=h)
    raise HTTPException(404, "kind must be rgb.jpg, thermal.png, thermal_preview.png or labels.png")


# --- Streaming -------------------------------------------------------------------------------


@app.websocket("/v1/stream")
async def stream(ws: WebSocket) -> None:
    """Drone sensor stream. See README for the message protocol."""
    await ws.accept()
    cfg: dict[str, Any] = {
        "drone_id": None,
        "width": 640,
        "height": 480,
        "hfov_deg": 84.0,
        "thermal_width": 320,
        "images": {"rgb", "thermal"},
        "truth": False,
        "rate_hz": 0.0,
    }
    latest: dict[str, Any] = {}
    wake = asyncio.Event()
    closed = False

    async def send_error(code: str, message: str, request_id: object = None) -> None:
        await ws.send_json(
            {"type": "error", "code": code, "message": message, "request_id": request_id}
        )

    async def render_and_send(pose_msg: dict[str, Any]) -> bool:
        try:
            lat, lon = float(pose_msg["lat"]), float(pose_msg["lon"])
            validate_position(lat, lon)
            when = resolve_time(pose_msg.get("t"))
            pose = Pose(
                lat,
                lon,
                float(pose_msg.get("alt_m", 120.0)),
                float(pose_msg.get("heading_deg", 0.0)),
                float(pose_msg.get("pitch_deg", -90.0)),
            )
            obs = await asyncio.to_thread(
                observe,
                pose,
                when,
                cfg["width"],
                cfg["height"],
                cfg["hfov_deg"],
                cfg["thermal_width"],
                cfg["truth"],
            )
            msg = await asyncio.to_thread(obs.to_message, set(cfg["images"]))
            msg.update(
                {
                    "type": "observation",
                    "drone_id": cfg["drone_id"],
                    "request_id": pose_msg.get("request_id"),
                }
            )
            await ws.send_json(msg)
            return True
        except LocationError as exc:
            await send_error("out_of_coverage", str(exc), pose_msg.get("request_id"))
        except TimeError as exc:
            await send_error("bad_time", str(exc), pose_msg.get("request_id"))
        except (KeyError, TypeError, ValueError) as exc:
            await send_error(
                "bad_request", f"invalid pose message: {exc}", pose_msg.get("request_id")
            )
        return False

    async def worker() -> None:
        while not closed:
            rate = cfg["rate_hz"]
            if rate > 0:
                started = asyncio.get_running_loop().time()
                if latest:
                    msg = {k: v for k, v in latest.items() if not k.startswith("_")}
                    if not latest.get("_pinned_time"):
                        msg.pop("t", None)  # follow the scenario clock
                    latest["_pending"] = False
                    if not await render_and_send(msg):
                        latest.clear()  # report a bad pose once, not every tick
                delay = max(0.0, 1.0 / rate - (asyncio.get_running_loop().time() - started))
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(wake.wait(), timeout=delay)
                wake.clear()
            else:
                await wake.wait()
                wake.clear()
                if latest.get("_pending"):
                    latest["_pending"] = False
                    msg = {k: v for k, v in latest.items() if not k.startswith("_")}
                    if not await render_and_send(msg):
                        latest.clear()

    task = asyncio.create_task(worker())
    try:
        while True:
            try:
                msg = await ws.receive_json()
            except (json.JSONDecodeError, ValueError):
                await send_error("bad_request", "messages must be JSON objects")
                continue
            kind = msg.get("type")
            if kind == "configure":
                for key in (
                    "drone_id",
                    "width",
                    "height",
                    "hfov_deg",
                    "thermal_width",
                    "truth",
                    "rate_hz",
                ):
                    if key in msg:
                        cfg[key] = msg[key]
                if "camera" in msg:
                    cfg.update(
                        {
                            k: msg["camera"][k]
                            for k in ("width", "height", "hfov_deg")
                            if k in msg["camera"]
                        }
                    )
                if "images" in msg:
                    cfg["images"] = set(msg["images"])
                cfg["rate_hz"] = float(cfg["rate_hz"] or 0.0)
                await ws.send_json(
                    {
                        "type": "configured",
                        "config": {**cfg, "images": sorted(cfg["images"])},
                        "clock": clock.state(),
                    }
                )
                wake.set()
            elif kind == "pose":
                # Latest pose wins: if rendering falls behind, stale poses are skipped.
                latest.clear()
                latest.update(msg)
                latest["_pending"] = True
                latest["_pinned_time"] = "t" in msg
                wake.set()
            elif kind == "clock":
                await ws.send_json({"type": "clock", **clock.state()})
            else:
                await send_error(
                    "bad_request", f"unknown message type {kind!r}; use configure, pose or clock"
                )
    except WebSocketDisconnect:
        pass
    finally:
        closed = True
        wake.set()
        task.cancel()


# --- Map tiles -------------------------------------------------------------------------------


@lru_cache(maxsize=16)
def _store(layer_id: str) -> TileStore:
    return TileStore(LAYERS[layer_id].path)


@lru_cache(maxsize=512)
def _scene_tile(z: int, x: int, y: int, minute_key: int) -> bytes:
    t = _minute_to_time(minute_key)
    k = np.arange(TILE_SIZE) + 0.5
    px, py = np.meshgrid(x * TILE_SIZE + k, y * TILE_SIZE + k)
    lon, lat = global_px_to_lonlat(px.ravel(), py.ravel(), z)
    gsd = ground_resolution_m(float(np.mean(lat)), z)
    g = render_ground(
        GroundPoints.from_lonlat(lon, lat),
        t,
        gsd,
        None,
        seed=z * 1_000_003 + x * 7919 + y,
        want_rgb=True,
        want_thermal=False,
        want_labels=False,
    )
    assert g.rgb is not None
    img = (g.rgb.reshape(TILE_SIZE, TILE_SIZE, 3) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, "JPEG", quality=85)
    return buf.getvalue()


def _minute_to_time(minute_key: int) -> datetime:
    return SCENARIO_START + timedelta(minutes=minute_key)


@app.get("/v1/tiles/{layer}/{z}/{x}/{y}.jpg")
def get_tile(layer: str, z: int, x: int, y: int, t: str | None = None) -> Response:
    """XYZ tiles. `layer` is a raw imagery layer id, or `scene` for the rendered view at time t."""
    b = tile_bounds(z, x, y)
    if b.east < AOI.west or b.west > AOI.east or b.north < AOI.south or b.south > AOI.north:
        raise HTTPException(404, "tile outside the coverage area")
    if layer == "scene":
        if z < 13 or z > 20:
            raise HTTPException(404, "scene tiles are available at zoom 13-20")
        when = resolve_time(t)
        minute_key = int((when - SCENARIO_START).total_seconds() // 60)
        return Response(
            _scene_tile(z, x, y, minute_key),
            media_type="image/jpeg",
            headers={
                "X-Ember-Scenario-Time": _minute_to_time(minute_key).isoformat(),
                "X-Ember-Epoch": epoch_for(when).name,
            },
        )
    if layer not in LAYERS:
        raise HTTPException(404, f"unknown layer {layer!r}; use scene or one of {sorted(LAYERS)}")
    data = _store(layer).get(z, x, y)
    if data is None:
        raise HTTPException(404, "no tile")
    media = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    return Response(data, media_type=media, headers={"Cache-Control": "public, max-age=86400"})


# --- Ground truth ----------------------------------------------------------------------------


@app.get("/v1/truth/fire")
def get_fire_truth(
    t: str | None = None, format: str = Query("geojson", pattern="^(geojson|summary)$")
) -> dict[str, Any]:
    """Synthetic fire state over the whole area (ground truth for evaluation and dashboards)."""
    when = resolve_time(t)
    sc = scenario()
    if format == "summary":
        return {"scenario_time": when.astimezone(HST).isoformat(), **sc.summary(when)}
    fc = sc.class_polygons(when)
    return {
        **fc,
        "scenario_time": when.astimezone(HST).isoformat(),
        "synthetic": epoch_for(when).synthetic,
    }


# --- Context feeds ---------------------------------------------------------------------------


@app.get("/v1/context/weather")
def get_weather(t: str | None = None) -> dict[str, Any]:
    when = resolve_time(t)
    return {"scenario_time": when.astimezone(HST).isoformat(), **weather_at(when)}


@app.get("/v1/context/satellite")
def get_satellite(
    lat: LatQ,
    lon: LonQ,
    t: str | None = None,
    radius_km: float = 15.0,
    polar_window_h: float = 12.0,
) -> dict[str, Any]:
    validate_position(lat, lon)
    when = resolve_time(t)
    return {
        "scenario_time": when.astimezone(HST).isoformat(),
        **satellite_at(when, lat, lon, radius_km, polar_window_h),
    }


@app.get("/v1/context/structures")
def get_structures(
    lat: LatQ, lon: LonQ, radius_m: float = 300.0, t: str | None = None, truth: bool = False
) -> dict[str, Any]:
    validate_position(lat, lon)
    if not 0 < radius_m <= 3000:
        raise ValueError("radius_m must be in (0, 3000]")
    when = resolve_time(t)
    return {
        "scenario_time": when.astimezone(HST).isoformat(),
        **structures().near(lat, lon, radius_m, when, truth),
    }


@lru_cache(maxsize=1)
def _reports() -> list[dict[str, Any]]:
    with ANCHORS_CSV.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["time"] = datetime.fromisoformat(r["time_hst"]).replace(tzinfo=HST)
    return rows


@app.get("/v1/context/reports")
def get_reports(t: str | None = None) -> dict[str, Any]:
    """Time-stamped fire sightings from the FSRI timeline (911/dispatch), up to time t."""
    when = resolve_time(t)
    out = [
        {
            "time": r["time"].isoformat(),
            "lat": float(r["lat"]),
            "lon": float(r["lon"]),
            "location_precision_m": float(r["precision_m"]),
            "text": r["quote"],
            "source": f"FSRI timeline: {r['fsri_source']}",
        }
        for r in _reports()
        if r["time"] <= when
    ]
    return {
        "scenario_time": when.astimezone(HST).isoformat(),
        "count": len(out),
        "reports": out,
        "license": "FSRI Lahaina Fire Comprehensive Timeline dataset, CC BY-SA 4.0",
    }
