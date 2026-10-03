"""Fire and smoke as faceted meshes: unit-sized, for a consumer to scale, tint and fade."""

from __future__ import annotations

import math
import random

import numpy as np

from .gltf import Material, Model, Node
from .mesh import Mesh, blob, linear, loft, ring

MATERIALS = {
    "flame": Material(0xFFFFFF, unlit=True),
    "smoke": Material(0xC9CBCE, roughness=1.0),
}
# Colour up a tongue of flame, hottest at its foot.
_HEAT_AT = [0.0, 0.28, 0.58, 0.84, 1.0]
_HEAT = np.array([linear(c) for c in (0xFFF3B4, 0xFFC93A, 0xFF7D1C, 0xE83A0D, 0xA51A06)])


def _heat(mesh: Mesh, height: float, base: float = 0.0) -> Mesh:
    t = (mesh.centres()[:, 1] - base) / height
    return mesh.shade(np.stack([np.interp(t, _HEAT_AT, _HEAT[:, c]) for c in range(3)], axis=1))


def _tongue(
    rng: random.Random, height: float, girth: float, lean: tuple[float, float] = (0.0, 0.0)
) -> Mesh:
    """One flame standing on the origin: a swaying, twisting teardrop that ends in a point."""
    sides, spans = 5, 6
    phase, twist = rng.uniform(0, math.tau), rng.uniform(40, 90)
    sway = rng.uniform(0.08, 0.14) * height
    rings = []
    for k in range(spans + 1):
        t = k / spans
        width = girth * float(
            np.interp(t, [0, 0.12, 0.32, 0.6, 0.85, 1], [0.6, 0.95, 1, 0.62, 0.28, 0])
        )
        at = (
            lean[0] * t + sway * t * math.sin(phase + 4.2 * t),
            lean[1] * t + sway * t * math.cos(1.3 * phase + 3.4 * t),
        )
        rings.append(ring(sides, width, height * t, phase=twist * t, at=at))
    return _heat(loft(rings, bottom=True), height)


def flame(seed: int, tongues: int, spread: float, tallest: float) -> Model:
    """A fire one metre high: `tongues` flames around a main one, `spread` metres out from it."""
    rng = random.Random(seed)
    parts = [_tongue(rng, tallest, 0.2 + 0.25 * spread)]
    bearing = rng.uniform(0, math.tau)
    for k in range(tongues):
        a = bearing + (k + rng.uniform(-0.25, 0.25)) * math.tau / tongues
        out = (math.cos(a), math.sin(a))
        reach = spread * rng.uniform(0.75, 1.1)
        height = tallest * rng.uniform(0.42, 0.72)
        tongue = _tongue(rng, height, rng.uniform(0.11, 0.15), (out[0] * 0.12, out[1] * 0.12))
        parts.append(tongue.move(out[0] * reach, 0, out[1] * reach))
    for _ in range(2):
        # Licks that have torn free above the fire.
        a, y = rng.uniform(0, math.tau), tallest * rng.uniform(0.86, 1.0)
        lick = blob(rng, 0, 0.1).scale(0.035, 0.085, 0.035)
        parts.append(
            _heat(lick.move(0.16 * math.cos(a), y, 0.16 * math.sin(a)), 1.0, base=y - 0.75)
        )
    fire = Mesh.join(parts)
    fire = fire.scale(1 / float(fire.tris[:, :, 1].max())).speckle(rng, 0.07)
    root = Node("flame")
    root.add("flame", fire)
    points = fire.tris.reshape(-1, 3)
    width = 2 * float(np.hypot(points[:, 0], points[:, 2]).max())
    return Model(root, MATERIALS, {"heightM": 1.0, "widthM": round(width, 2)})


def smoke(seed: int) -> Model:
    """A puff of smoke one metre in radius: a few billows merged, lighter on top."""
    rng = random.Random(seed)
    billows = [blob(rng, 1, 0.08)]
    bearing = rng.uniform(0, math.tau)
    for k in range(5):
        a = bearing + (k + rng.uniform(-0.3, 0.3)) * math.tau / 5
        rise, reach = rng.uniform(-0.25, 0.75), rng.uniform(0.75, 1.0)
        flat = reach * math.sqrt(1 - rise**2)
        at = (flat * math.cos(a), reach * rise, flat * math.sin(a))
        billows.append(blob(rng, 1, 0.08).scale(rng.uniform(0.48, 0.72)).move(*at))
    puff = Mesh.join(billows)
    puff = puff.move(*(-puff.tris.reshape(-1, 3).mean(axis=0)))
    puff = puff.scale(1 / float(np.linalg.norm(puff.tris, axis=2).max()))
    root = Node("smoke")
    root.add("smoke", puff.under(0.86).graded(0.7, 1.0).speckle(rng, 0.04))
    return Model(root, MATERIALS, {"radiusM": 1.0})
