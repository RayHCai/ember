"""Simulated drones for a real edge-connector, several to one process (`drone-runtime fleet`)."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .geo import LatLng, LocalFrame

NAMES = ("Osprey", "Harrier", "Merlin", "Hobby", "Kite", "Peregrine", "Saker", "Lanner")


@dataclass(frozen=True)
class FleetMember:
    drone_id: str
    name: str
    home: LatLng


def ring(center: LatLng, count: int, radius_m: float = 12.0) -> list[LatLng]:
    """Homes a few metres apart around `center`, as if set down by hand beside the edge server."""
    local = LocalFrame(center)
    return [
        local.latlng(
            radius_m * math.cos(2 * math.pi * i / count),
            radius_m * math.sin(2 * math.pi * i / count),
        )
        for i in range(count)
    ]


def fleet_members(prefix: str, count: int, center: LatLng) -> list[FleetMember]:
    if count < 1:
        raise ValueError(f"a fleet needs at least one drone, got {count}")
    return [
        FleetMember(f"{prefix}-{i + 1}", NAMES[i] if i < len(NAMES) else f"Sim {i + 1}", home)
        for i, home in enumerate(ring(center, count))
    ]
