"""The sim's five growth forms. Each takes a seed (the variant) and a level of detail (0 or 1).

Wood is `bark`; everything that burns away is `foliage`, so a consumer can recolour or drop the
crown and keep the trunk and branches as the charred skeleton.
"""

from __future__ import annotations

import math
import random

import numpy as np

from .gltf import Material, Model, Node
from .mesh import Array, Mesh, blob, loft, ring, tube


def _materials(bark: int, foliage: int) -> dict[str, Material]:
    return {
        "bark": Material(bark, roughness=0.95),
        "foliage": Material(foliage, roughness=0.85, double_sided=True),
    }


def _lobe(
    rng: random.Random,
    at: tuple[float, float, float],
    radius: float,
    height: float,
    *,
    level: int = 1,
    belly: float = 0.6,
) -> Mesh:
    """A lump of crown around `at`, `radius` wide and `height` tall, flattened below by `belly`."""

    def flatten(p: Array) -> Array:
        p = p.copy()
        p[:, 1] = np.where(p[:, 1] < 0, p[:, 1] * belly, p[:, 1])
        return p

    return blob(rng, level, 0.2).warp(flatten).scale(radius, height, radius).move(*at)


def _crown(rng: random.Random, lobes: list[Mesh], shadow: float = 0.62) -> Mesh:
    """Lobes as one canopy: light on top, dark underneath, each facet a slightly different green."""
    return Mesh.join(lobes).under(0.7).graded(shadow, 1.0).speckle(rng, 0.1)


def _tree(root: Node, materials: dict[str, Material]) -> Model:
    _, high = Model(root, materials).bounds()
    crown = root.parts["foliage"].tris.reshape(-1, 3)
    reach = float(np.hypot(crown[:, 0], crown[:, 2]).max())
    return Model(
        root, materials, {"heightM": round(float(high[1]), 2), "crownRadiusM": round(reach, 2)}
    )


def broadleaf(seed: int, lod: int) -> Model:
    rng = random.Random(seed)
    height, radius = rng.uniform(8.5, 10.0), rng.uniform(3.6, 4.2)
    lean = (rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35))
    fork = (lean[0], 0.36 * height, lean[1])
    top = (lean[0] * 1.6, 0.72 * height, lean[1] * 1.6)
    root = Node("broadleaf")

    if lod > 0:
        trunk = tube(
            [(0, 0, 0), (lean[0] * 0.4, 0.1 * height, lean[1] * 0.4), top], [0.45, 0.27, 0.1], 5
        )
        root.add("bark", trunk.graded(1.0, 0.8))
        lobes = [_lobe(rng, (top[0], 0.66 * height, top[2]), 0.82 * radius, 0.3 * height)]
        for k in range(2):
            a = rng.uniform(0, math.tau) + k * math.pi
            at = (0.5 * radius * math.cos(a), 0.58 * height, 0.5 * radius * math.sin(a))
            lobes.append(_lobe(rng, at, 0.48 * radius, 0.2 * height, level=0))
        root.add("foliage", _crown(rng, lobes))
        return _tree(root, _materials(0x6B5138, 0x74A84B))

    base = [(0, 0, 0), (lean[0] * 0.2, 0.07 * height, lean[1] * 0.2), fork]
    root.add("bark", tube(base, [0.48, 0.3, 0.24], 6))
    lobes = [_lobe(rng, top, 0.56 * radius, 0.26 * height)]
    root.add("bark", tube([fork, top], [0.2, 0.07], 5))
    count = 4
    for k in range(count):
        a = (k + rng.uniform(-0.25, 0.25)) * math.tau / count
        out = (math.cos(a), math.sin(a))
        reach = rng.uniform(0.46, 0.56) * radius
        at = (fork[0] + out[0] * reach, rng.uniform(0.54, 0.62) * height, fork[2] + out[1] * reach)
        lobes.append(
            _lobe(rng, at, rng.uniform(0.44, 0.52) * radius, rng.uniform(0.2, 0.25) * height)
        )
        elbow = (fork[0] + out[0] * reach * 0.45, 0.47 * height, fork[2] + out[1] * reach * 0.45)
        root.add("bark", tube([fork, elbow, at], [0.16, 0.11, 0.05], 4))
    root.parts["bark"] = root.parts["bark"].graded(1.0, 0.72).speckle(rng, 0.08)
    root.add("foliage", _crown(rng, lobes))
    return _tree(root, _materials(0x6B5138, 0x74A84B))


def conifer(seed: int, lod: int) -> Model:
    rng = random.Random(seed)
    height, radius = rng.uniform(11.0, 13.0), rng.uniform(2.3, 2.7)
    tiers, boughs = (5, 7) if lod == 0 else (3, 5)
    root = Node("conifer")
    trunk = tube(
        [(0, 0, 0), (0, 0.18 * height, 0), (0, 0.9 * height, 0)], [0.34, 0.2, 0.04], 6 - lod
    )
    root.add("bark", trunk.graded(1.0, 0.75))

    parts: list[Mesh] = []
    for i in range(tiers):
        f = i / (tiers - 1)
        y = height * (0.14 + 0.62 * f)
        r = radius * (1.0 - 0.72 * f)
        apex = height if i == tiers - 1 else y + height * (0.3 - 0.07 * f) * (1 + 0.5 * lod)
        rise = apex - y
        at = (rng.uniform(-0.04, 0.04) * radius, rng.uniform(-0.04, 0.04) * radius)
        phase = rng.uniform(0, 360)
        # Bough tips reach out and droop; the notches between them sit higher and closer in.
        tips = ring(2 * boughs, r, y - 0.08 * rise, phase=phase, at=at)
        tips[1::2] = ring(2 * boughs, r * 0.62, y + 0.07 * rise, phase=phase, at=at)[1::2]
        point = ring(2 * boughs, 0.0, apex, at=at)
        rings = [tips, point]
        if lod == 0:
            rings = [tips, ring(2 * boughs, r * 0.4, y + 0.36 * rise, phase=phase, at=at), point]
        hub = np.broadcast_to(np.array([at[0], y + 0.14 * rise, at[1]]), tips.shape)
        skirt = Mesh.of(np.stack([hub, tips, np.roll(tips, -1, axis=0)], axis=1))
        parts += [loft(rings).graded(0.82, 1.0), skirt.shade(0.55)]
    root.add("foliage", Mesh.join(parts).graded(0.74, 1.0).speckle(rng, 0.1))
    return _tree(root, _materials(0x5A4030, 0x3F8050))


def _frond(
    crown: tuple[float, float, float],
    yaw: float,
    rise: float,
    droop: float,
    length: float,
    width: float,
    segments: int,
    *,
    feathered: bool = False,
) -> Mesh:
    """A palm frond: a midrib leaving `crown` at `rise` degrees and bending over, leaflets hung."""
    out = np.array([math.cos(yaw), 0.0, math.sin(yaw)])
    side = np.array([-math.sin(yaw), 0.0, math.cos(yaw)])
    up = np.array([0.0, 1.0, 0.0])
    spine = [np.array(crown)]
    edges: list[tuple[Array, Array]] = []
    for j in range(segments + 1):
        s = j / segments
        pitch = math.radians(rise - droop * s**1.3)
        along = math.cos(pitch) * out + math.sin(pitch) * up
        normal = np.cross(side, along)
        w = width * float(np.interp(s, [0, 0.2, 0.5, 0.8, 1], [0.2, 1.0, 0.95, 0.6, 0.06]))
        if feathered and j % 2 == 0 and 0 < j < segments:
            w *= 0.62
        hang = normal * (0.34 * w)
        edges.append((spine[j] - side * w / 2 - hang, spine[j] + side * w / 2 - hang))
        spine.append(spine[j] + along * (length / segments))
    tris = []
    for j in range(segments):
        (left0, right0), (left1, right1) = edges[j], edges[j + 1]
        a, b = spine[j], spine[j + 1]
        tris += [(a, right0, right1), (a, right1, b), (a, b, left1), (a, left1, left0)]
    return Mesh.of(np.array(tris))


def palm(seed: int, lod: int) -> Model:
    rng = random.Random(seed)
    height, radius = rng.uniform(10.0, 12.5), rng.uniform(3.0, 3.5)
    bearing, lean = rng.uniform(0, math.tau), rng.uniform(0.6, 1.7)
    top = 0.84 * height
    root = Node("palm")

    def stem(t: float) -> tuple[float, float, float]:
        off = lean * t**1.8
        return (off * math.cos(bearing), top * t, off * math.sin(bearing))

    def girth(t: float) -> float:
        return float(np.interp(t, [0, 0.07, 1], [0.42, 0.24, 0.17]))

    if lod == 0:
        # Each length of trunk flares towards its top, leaving the ring scars a palm carries.
        steps = 7
        path, radii = [], []
        for k in range(steps):
            t0, t1 = k / steps, (k + 1) / steps
            path += [stem(t0), stem(t1)]
            radii += [girth(t0) * (1.0 if k == 0 else 0.9), girth(t1) * 1.08]
        root.add("bark", tube(path, radii, 6, top=True).graded(0.85, 1.0).speckle(rng, 0.08))
    else:
        ts = [0.0, 0.1, 0.55, 1.0]
        root.add("bark", tube([stem(t) for t in ts], [girth(t) for t in ts], 4, top=True))

    crown = stem(1.0)
    fronds: list[Mesh] = []
    count, segments = (12, 7) if lod == 0 else (7, 3)
    for k in range(count):
        yaw = (k + rng.uniform(-0.3, 0.3)) * math.tau / count
        upper = k % 2 == 0
        rise = (58.0 if upper else 24.0) + rng.uniform(-8, 8)
        droop = (110.0 if upper else 85.0) + rng.uniform(-10, 10)
        length = radius * rng.uniform(1.05, 1.25) * (0.95 if upper else 1.0)
        frond = _frond(crown, yaw, rise, droop, length, 0.44 * radius, segments, feathered=lod == 0)
        fronds.append(frond.shade(rng.uniform(0.86, 1.0) * (1.0 if upper else 0.84)))
    if lod == 0:
        for k in range(2):
            yaw = bearing + k * math.pi + rng.uniform(-0.5, 0.5)
            fronds.append(_frond(crown, yaw, 80.0, 35.0, 0.62 * radius, 0.2 * radius, 3))
        root.add("bark", blob(rng, 0, 0.1).scale(0.3, 0.26, 0.3).move(*crown).shade(0.85))
        for k in range(3):
            a = bearing + k * math.tau / 3
            nut = blob(rng, 0, 0.08).scale(0.16)
            at = (crown[0] + 0.24 * math.cos(a), crown[1] - 0.22, crown[2] + 0.24 * math.sin(a))
            root.add("bark", nut.move(*at).shade(0.55))
    root.add("foliage", Mesh.join(fronds).speckle(rng, 0.1))
    return _tree(root, _materials(0x8F7A5C, 0x7DAE3C))


def umbrella(seed: int, lod: int) -> Model:
    rng = random.Random(seed)
    height, radius = rng.uniform(9.0, 11.0), rng.uniform(6.5, 8.0)
    lean = (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3))
    fork = (lean[0], 0.34 * height, lean[1])
    root = Node("umbrella")
    base = [(0, 0, 0), (lean[0] * 0.3, 0.09 * height, lean[1] * 0.3), fork]
    root.add("bark", tube(base, [0.85, 0.52, 0.44], 7 - 2 * lod))

    limbs = 5 if lod == 0 else 3
    lobes: list[Mesh] = []
    if lod == 0:
        lobes.append(
            _lobe(rng, (lean[0], 0.83 * height, lean[1]), 0.6 * radius, 0.15 * height, belly=0.4)
        )
    else:
        lobes.append(
            _lobe(rng, (lean[0], 0.8 * height, lean[1]), 0.98 * radius, 0.17 * height, belly=0.4)
        )
    for k in range(limbs):
        a = (k + rng.uniform(-0.2, 0.2)) * math.tau / limbs
        out = (math.cos(a), math.sin(a))
        reach = rng.uniform(0.52, 0.62) * radius
        end = (fork[0] + out[0] * reach, rng.uniform(0.74, 0.8) * height, fork[2] + out[1] * reach)
        elbow = (fork[0] + out[0] * reach * 0.5, 0.58 * height, fork[2] + out[1] * reach * 0.5)
        if lod == 0:
            root.add("bark", tube([fork, elbow, end], [0.3, 0.19, 0.08], 5))
            lobes.append(
                _lobe(
                    rng,
                    end,
                    rng.uniform(0.4, 0.47) * radius,
                    rng.uniform(0.1, 0.13) * height,
                    belly=0.4,
                )
            )
        else:
            root.add("bark", tube([fork, end], [0.28, 0.08], 4))
    root.parts["bark"] = root.parts["bark"].graded(1.0, 0.7).speckle(rng, 0.08)
    root.add("foliage", _crown(rng, lobes, shadow=0.7))
    return _tree(root, _materials(0x66503A, 0x5F9A44))


def shrub(seed: int, lod: int) -> Model:
    rng = random.Random(seed)
    height, radius = rng.uniform(1.5, 2.0), rng.uniform(1.2, 1.6)
    root = Node("shrub")
    lobes = [_lobe(rng, (0, 0.3 * height, 0), 0.66 * radius, 0.62 * height, belly=1.0)]
    bearing = rng.uniform(0, math.tau)
    for k in range(3 if lod == 0 else 1):
        a = bearing + (k + rng.uniform(-0.2, 0.2)) * math.tau / 3
        reach = rng.uniform(0.46, 0.56) * radius
        at = (reach * math.cos(a), 0.16 * height, reach * math.sin(a))
        size = rng.uniform(0.4, 0.5)
        lobes.append(_lobe(rng, at, size * radius, (size + 0.1) * height, level=1 - lod, belly=1.0))

    def grounded(points: Array) -> Array:
        return np.maximum(points, [-np.inf, 0.0, -np.inf])

    # The clump sits into the ground: what would be below it is never seen and is left out.
    crown = _crown(rng, lobes, shadow=0.66).warp(grounded)
    root.add("foliage", crown.keep(crown.tris[:, :, 1].max(axis=1) > 0.0))
    return _tree(root, _materials(0x6B5138, 0x7DB048))
