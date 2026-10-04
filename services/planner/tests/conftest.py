"""A synthetic watch zone, written in metres around an origin and sent as wire JSON.

A 3 km square zone with a fire at its centre, a town 2 km east and a hamlet 2.5 km west. One road
runs east-west south of the fire, another north-south through the town to a shelter in the north.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from ember_planner.grid import LocalFrame
from ember_planner.wire import LatLng

ORIGIN = LatLng(lat=20.88, lng=-156.67)
NOW = datetime(2026, 10, 3, 18, 0, tzinfo=UTC)
FRAME = LocalFrame(ORIGIN)

Scenario = Callable[..., dict[str, Any]]


def ll(x: float, y: float) -> dict[str, float]:
    p = FRAME.to_latlng(x, y)
    return {"lat": p.lat, "lng": p.lng}


def square(cx: float, cy: float, half: float) -> list[dict[str, float]]:
    return [
        ll(cx - half, cy - half),
        ll(cx + half, cy - half),
        ll(cx + half, cy + half),
        ll(cx - half, cy + half),
    ]


def iso(t: datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


def job(**options: Any) -> dict[str, Any]:
    return {
        "jobId": "job-1",
        "zoneId": "zone-1",
        "requestedAt": iso(NOW),
        "requestedBy": "operator-1",
        "options": options,
    }


def build_context(**overrides: Any) -> dict[str, Any]:
    ctx: dict[str, Any] = {
        "zoneId": "zone-1",
        "name": "Test ridge",
        "boundary": square(0, 0, 1500),
        "generatedAt": iso(NOW),
        "weather": {
            "observedAt": iso(NOW),
            "windSpeedMps": 12.0,
            "windFromDeg": 270.0,
            "temperatureC": 30.0,
            "relativeHumidityPct": 20.0,
        },
        "terrain": None,
        "riskZones": [
            {
                "id": "fire-1",
                "risk": "on_fire",
                "polygon": square(0, 0, 60),
                "confidence": 0.9,
                "observedAt": iso(NOW - timedelta(minutes=10)),
            }
        ],
        "detections": [],
        "civilianAreas": [
            {
                "id": "town",
                "name": "Town",
                "center": ll(2000, 0),
                "polygon": square(2000, 0, 200),
                "population": 500,
            },
            {
                "id": "hamlet",
                "name": "Hamlet",
                "center": ll(-2500, 0),
                "polygon": None,
                "population": 40,
            },
        ],
        "roads": [
            {
                "id": "hwy",
                "name": "Coast Hwy",
                "kind": "primary",
                "path": [ll(-4000, -600), ll(4000, -600)],
            },
            {
                "id": "main",
                "name": "Main St",
                "kind": "residential",
                "path": [ll(2000, -600), ll(2000, 0), ll(2000, 2800)],
            },
        ],
        "safeZones": [
            {"id": "north", "name": "North school", "location": ll(2000, 2800), "capacity": 800}
        ],
        "stations": [{"id": "st-1", "name": "Station 1", "location": ll(-3500, -600)}],
    }
    ctx.update(overrides)
    return ctx


@pytest.fixture
def scenario() -> Scenario:
    return build_context
