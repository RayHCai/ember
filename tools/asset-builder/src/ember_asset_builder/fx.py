"""Fire and smoke as faceted meshes: unit-sized, for a consumer to scale, tint and fade."""

from __future__ import annotations

import math
import random

import numpy as np

from .gltf import Material, Model, Node
from .mesh import Lobe, Mesh, blob, clump, linear, loft, ring

MATERIALS = {
    "flame": Material(0xFFFFFF, unlit=True),
    "smoke": Material(0xD2D4D6, roughness=1.0),
}
# Colour up a tongue of flame: the core burns pale, the tongues around it run to dark red tips.
_AT = [0.0, 0.3, 0.62, 0.86, 1.0]
_OUTER = np.array([linear(c) for c in (0xFFC23A, 0xFF8A1E, 0xF2500F, 0xC92A08, 0x8E1505)])
_CORE = np.array([linear(c) for c in (0xFFF8D6, 0xFFEE9A, 0xFFD24A, 0xFFA526, 0xFF7A18)])


def _heat(mesh: Mesh, ramp: np.ndarray, low: float, high: float) -> Mesh:
    t = np.clip((mesh.centres()[:, 1] - low) / (high - low), 0.0, 1.0)
    return mesh.shade(np.stack([np.interp(t, _AT, ramp[:, c]) for c in range(3)], axis=1))


def _tongue(
    rng: random.Random,
    height: float,
    girth: float,
    ramp: np.ndarray,
    lean: tuple[float, float] = (0.0, 0.0),
    *,
    sides: int = 4,
    spans: int = 4,
) -> Mesh:
    """One flame standing on the origin: a swaying, twisting teardrop drawn out to a point."""
    phase, twist = rng.uniform(0, math.tau), rng.uniform(50, 110)
    sway = rng.uniform(0.07, 0.13) * height
    rings = []
    for k in range(spans + 1):
        t = k / spans
        width = girth * float(np.interp(t, [0, 0.2, 0.45, 0.75, 1], [0.6, 1, 0.75, 0.3, 0]))
        bend = t**1.5
        at = (
            lean[0] * bend + sway * t * math.sin(phase + 4.6 * t),
            lean[1] * bend + sway * t * math.cos(1.3 * phase + 3.8 * t),
        )
        rings.append(ring(sides, width, height * t, phase=twist * t, at=at))
    return _heat(loft(rings, bottom=True), ramp, 0.0, height)


def _fire(
    rng: random.Random, height: float, girth: float, petals: int, sides: int, spans: int
) -> Mesh:
    """A pale core with darker tongues standing round it, so the core shows between them."""
    parts = [_tongue(rng, height, girth * 0.62, _CORE, sides=sides, spans=spans)]
    bearing = rng.uniform(0, math.tau)
    for k in range(petals):
        a = bearing + (k + rng.uniform(-0.25, 0.25)) * math.tau / petals
        out = (math.cos(a), math.sin(a))
        reach = girth * rng.uniform(0.62, 0.8)
        tall = height * rng.uniform(0.5, 0.82)
        lean = (out[0] * 0.3 * girth, out[1] * 0.3 * girth)
        tongue = _tongue(
            rng, tall, girth * rng.uniform(0.42, 0.56), _OUTER, lean, sides=sides, spans=spans
        )
        parts.append(tongue.move(out[0] * reach, 0, out[1] * reach))
    return Mesh.join(parts)


def flame(seed: int, fires: int, spread: float, tallest: float) -> Model:
    """A fire one metre high: a main fire with `fires` smaller ones up to `spread` metres out.

    Thousands are drawn at once, so the more fires a model holds the plainer each one is.
    """
    rng = random.Random(seed)
    main = (4, 5, 4) if fires == 0 else (3, 4, 4) if fires < 4 else (3, 4, 3)
    parts = [_fire(rng, tallest, 0.13 + 0.12 * tallest, *main)]
    bearing = rng.uniform(0, math.tau)
    for k in range(fires):
        a = bearing + (k + rng.uniform(-0.3, 0.3)) * math.tau / fires
        reach = spread * rng.uniform(0.6, 1.0)
        small = _fire(rng, tallest * rng.uniform(0.35, 0.6), rng.uniform(0.07, 0.1), 1, 3, 2)
        parts.append(small.move(reach * math.cos(a), 0, reach * math.sin(a)))
    for _ in range(2 if fires == 0 else 1):
        # Sparks and licks that have torn free above the fire.
        a, y = rng.uniform(0, math.tau), tallest * rng.uniform(0.8, 1.0)
        reach = rng.uniform(0.05, 0.2)
        lick = blob(rng, 0, 0.1).scale(0.022, rng.uniform(0.03, 0.08), 0.022)
        lick = lick.move(reach * math.cos(a), y, reach * math.sin(a))
        parts.append(_heat(lick, _OUTER, y - 1.2, y + 0.4))
    fire = Mesh.join(parts)
    fire = fire.scale(1 / float(fire.tris[:, :, 1].max())).speckle(rng, 0.06)
    root = Node("flame")
    root.add("flame", fire)
    points = fire.tris.reshape(-1, 3)
    width = 2 * float(np.hypot(points[:, 0], points[:, 2]).max())
    return Model(root, MATERIALS, {"heightM": 1.0, "widthM": round(width, 2)})


def smoke(seed: int) -> Model:
    """A puff of smoke one metre in radius: billows merged into one cloud, lighter on top."""
    rng = random.Random(seed)
    lobes: list[Lobe] = [((0.0, 0.0, 0.0), 0.72, 0.66, 1)]
    bearing = rng.uniform(0, math.tau)
    # Thousands are drawn at once: the billows round the core are plain icosahedra.
    for k in range(5):
        a = bearing + (k + rng.uniform(-0.3, 0.3)) * math.tau / 5
        rise, reach = rng.uniform(-0.3, 0.6), rng.uniform(0.5, 0.68)
        flat = reach * math.sqrt(1 - rise**2)
        size = rng.uniform(0.34, 0.5)
        lobes.append(((flat * math.cos(a), reach * rise, flat * math.sin(a)), size, size * 0.92, 0))
    lobes.append(((0.1, 0.5, -0.05), 0.42, 0.4, 0))
    puff = Mesh.join(clump(rng, lobes, lump=0.07))
    puff = puff.move(*(-puff.tris.reshape(-1, 3).mean(axis=0)))
    puff = puff.scale(1 / float(np.linalg.norm(puff.tris, axis=2).max()))
    root = Node("smoke")
    root.add("smoke", puff.under(0.84).graded(0.8, 1.0).speckle(rng, 0.03))
    return Model(root, MATERIALS, {"radiusM": 1.0})
