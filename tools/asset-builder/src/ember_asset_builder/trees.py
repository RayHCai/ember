"""The sim's five growth forms. Each takes a seed (the variant) and a level of detail: 0 for
close up, 1 for the middle distance, 2 for a far-off silhouette of a few dozen triangles.

Wood is `bark`; everything that burns away is `foliage`, so a consumer can recolour or drop the
crown and keep the trunk and branches as the charred skeleton.
"""

from __future__ import annotations

import math
import random

import numpy as np

from .gltf import Material, Model, Node
from .mesh import Array, Lobe, Mesh, blob, clump, loft, ring, tube

Point = tuple[float, float, float]


def _materials(bark: int, foliage: int) -> dict[str, Material]:
    return {
        "bark": Material(bark, roughness=0.95),
        "foliage": Material(foliage, roughness=0.85, double_sided=True),
    }


def _crown(
    rng: random.Random, lobes: list[Lobe], *, belly: float = 0.55, shadow: float = 0.6
) -> Mesh:
    """Lobes as one canopy: faces buried in a neighbour dropped, each lobe its own green,
    light on top and dark underneath."""

    kept = []
    for mesh in clump(rng, lobes, belly=belly):
        hue = (rng.uniform(0.84, 1.0), 1.0, rng.uniform(0.7, 1.0))
        kept.append(mesh.shade(hue).shade(rng.uniform(0.9, 1.0)))
    return Mesh.join(kept).under(0.66).graded(shadow, 1.0).speckle(rng, 0.07)


def _trunk(
    rng: random.Random, path: list[Point], radii: list[float], sides: int, flare: float
) -> Mesh:
    """A trunk whose foot spreads into root buttresses."""
    stem = tube(path, radii, sides)
    if flare <= 0:
        return stem
    foot = ring(sides, radii[0] * flare, 0.0, phase=rng.uniform(0, 360))
    foot[::2] *= np.array([1.25, 1.0, 1.25])
    collar = ring(sides, radii[0] * 1.05, radii[0] * 1.6, at=(path[0][0], path[0][2]))
    return Mesh.join([loft([foot, collar]), stem.move(y=radii[0] * 1.6)])


def _tree(root: Node, materials: dict[str, Material]) -> Model:
    _, high = Model(root, materials).bounds()
    crown = root.parts["foliage"].tris.reshape(-1, 3)
    reach = float(np.hypot(crown[:, 0], crown[:, 2]).max())
    return Model(
        root, materials, {"heightM": round(float(high[1]), 2), "crownRadiusM": round(reach, 2)}
    )


def _polar(at: Point, bearing: float, reach: float, y: float) -> Point:
    return (at[0] + reach * math.cos(bearing), y, at[2] + reach * math.sin(bearing))


def broadleaf(seed: int, lod: int) -> Model:
    """Round-crowned shade tree: mango, kukui, banyan."""
    rng = random.Random(seed)
    height, radius = rng.uniform(9.0, 10.5), rng.uniform(4.0, 4.6)
    lean = (rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4))
    fork: Point = (lean[0], 0.33 * height, lean[1])
    top: Point = (lean[0] * 1.5, 0.7 * height, lean[1] * 1.5)
    root = Node("broadleaf")
    materials = _materials(0x6B5138, 0x6FA646)
    spin = rng.uniform(0, math.tau)

    if lod == 2:
        root.add("bark", tube([(0, 0, 0), top], [0.4, 0.12], 3))
        root.add(
            "foliage", _crown(rng, [((top[0], 0.66 * height, top[2]), radius, 0.34 * height, 0)])
        )
        return _tree(root, materials)

    sides = 7 if lod == 0 else 4
    path = [(0.0, 0.0, 0.0), (lean[0] * 0.3, 0.12 * height, lean[1] * 0.3), fork]
    root.add("bark", _trunk(rng, path, [0.5, 0.34, 0.27], sides, 1.7 if lod == 0 else 0.0))
    root.add("bark", tube([fork, top], [0.22, 0.07], 5 if lod == 0 else 3))
    lobes: list[Lobe] = [(top, (0.62 if lod == 0 else 0.78) * radius, 0.27 * height, 1)]
    limbs = 5 if lod == 0 else 3
    for k in range(limbs):
        a = spin + (k + rng.uniform(-0.2, 0.2)) * math.tau / limbs
        reach = rng.uniform(0.5, 0.6) * radius
        tip = _polar(fork, a, reach, rng.uniform(0.55, 0.63) * height)
        elbow = _polar(fork, a, reach * 0.45, 0.46 * height)
        root.add("bark", tube([fork, elbow, tip], [0.18, 0.12, 0.05], 5 if lod == 0 else 3))
        lobes.append(
            (tip, rng.uniform(0.42, 0.5) * radius, rng.uniform(0.19, 0.23) * height, 1 - lod)
        )
        if lod == 0:
            twig = _polar(tip, a + rng.uniform(-0.9, 0.9), 0.22 * radius, tip[1] + 0.06 * height)
            root.add("bark", tube([elbow, twig], [0.07, 0.03], 3))
    if lod == 0:
        for k in range(3):
            a = spin + 0.6 + (k + rng.uniform(-0.2, 0.2)) * math.tau / 3
            at = _polar(top, a, 0.3 * radius, rng.uniform(0.76, 0.8) * height)
            lobes.append((at, rng.uniform(0.3, 0.36) * radius, 0.17 * height, 1))
        for k in range(3):
            a = spin + 0.3 + (k + rng.uniform(-0.3, 0.3)) * math.tau / 3
            at = _polar(fork, a, 0.74 * radius, rng.uniform(0.47, 0.52) * height)
            lobes.append((at, rng.uniform(0.22, 0.28) * radius, 0.11 * height, 0))
        root.parts["bark"] = root.parts["bark"].graded(1.0, 0.72).speckle(rng, 0.08)
    root.add("foliage", _crown(rng, lobes))
    return _tree(root, materials)


def _bough(length: float, width: float, droop: float, thick: float) -> Mesh:
    """One conifer bough reaching along +X from the trunk: a ridged kite that droops, tip lifted."""
    hub = (0.0, 0.0, 0.0)
    ridge = (0.45 * length, thick - 0.3 * droop, 0.0)
    left = (0.5 * length, -0.55 * droop, width / 2)
    right = (0.5 * length, -0.55 * droop, -width / 2)
    tip = (length, -droop * 0.8, 0.0)
    upper = [(hub, left, ridge), (hub, ridge, right), (ridge, left, tip), (ridge, tip, right)]
    lower = [(hub, tip, left), (hub, right, tip)]
    return Mesh.join([Mesh.of(np.array(upper)), Mesh.of(np.array(lower)).shade(0.6)])


def conifer(seed: int, lod: int) -> Model:
    """Cook pine: a straight mast carrying whorls of boughs that shorten towards the tip."""
    rng = random.Random(seed)
    height, radius = rng.uniform(13.0, 15.0), rng.uniform(2.5, 2.9)
    root = Node("conifer")
    materials = _materials(0x5A4030, 0x3B7D4F)
    if lod == 2:
        root.add("bark", tube([(0, 0, 0), (0, 0.3 * height, 0)], [0.3, 0.2], 3))
        cones = [
            loft([ring(4, radius * 0.8, 0.16 * height), ring(4, 0.0, 0.74 * height)]),
            loft([ring(4, radius * 0.48, 0.5 * height, phase=45), ring(4, 0.0, height)]),
        ]
        root.add("foliage", Mesh.join(cones).graded(0.7, 1.0))
        return _tree(root, materials)

    tiers, boughs = (9, 6) if lod == 0 else (6, 5)
    root.add(
        "bark",
        tube(
            [(0, 0, 0), (0, 0.2 * height, 0), (0, 0.96 * height, 0)],
            [0.34, 0.22, 0.04],
            6 if lod == 0 else 3,
        ).graded(1.0, 0.75),
    )
    pieces: list[Mesh] = []
    for i in range(tiers):
        f = i / (tiers - 1)
        y = height * (0.16 + 0.74 * f)
        reach = radius * (1.0 - 0.8 * f**1.15)
        phase = rng.uniform(0, 360)
        for k in range(boughs):
            if lod == 0:
                bough = _bough(
                    reach * rng.uniform(0.88, 1.0), reach * 0.74, reach * 0.22, 0.06 * reach + 0.08
                )
            else:
                flat = [
                    (0.0, 0.0, 0.0),
                    (0.5 * reach, -0.1 * reach, 0.42 * reach),
                    (reach, -0.18 * reach, 0.0),
                    (0.5 * reach, -0.1 * reach, -0.42 * reach),
                ]
                bough = Mesh.of(
                    np.array([(flat[0], flat[1], flat[2]), (flat[0], flat[2], flat[3])])
                )
            shade = (rng.uniform(0.86, 1.0), 1.0, rng.uniform(0.8, 1.0))
            pieces.append(
                bough.turn("y", phase + k * 360 / boughs)
                .move(y=y)
                .shade(shade)
                .shade(0.8 + 0.2 * f)
            )
    # A slim core of foliage keeps the mast from showing between the whorls.
    core = loft(
        [
            ring(6, radius * 0.3, 0.2 * height),
            ring(6, radius * 0.14, 0.7 * height),
            ring(6, 0.0, height),
        ]
    )
    pieces.append(core.graded(0.72, 0.95))
    root.add("foliage", Mesh.join(pieces).speckle(rng, 0.08))
    return _tree(root, materials)


def _frond(
    crown: Point,
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
            w *= 0.6
        hang = normal * (0.4 * w)
        edges.append((spine[j] - side * w / 2 - hang, spine[j] + side * w / 2 - hang))
        spine.append(spine[j] + along * (length / segments))
    tris = []
    for j in range(segments):
        (left0, right0), (left1, right1) = edges[j], edges[j + 1]
        a, b = spine[j], spine[j + 1]
        tris += [(a, right0, right1), (a, right1, b), (a, b, left1), (a, left1, left0)]
    return Mesh.of(np.array(tris))


def palm(seed: int, lod: int) -> Model:
    """Coconut palm: a leaning, ring-scarred trunk under a crown of arching fronds."""
    rng = random.Random(seed)
    height, radius = rng.uniform(10.5, 12.5), rng.uniform(3.1, 3.6)
    bearing, lean = rng.uniform(0, math.tau), rng.uniform(0.7, 1.8)
    top = 0.84 * height
    root = Node("palm")
    materials = _materials(0x94805F, 0x78AB3A)

    def stem(t: float) -> Point:
        off = lean * t**1.8
        return (off * math.cos(bearing), top * t, off * math.sin(bearing))

    def girth(t: float) -> float:
        return float(np.interp(t, [0, 0.06, 0.14, 1], [0.5, 0.36, 0.25, 0.18]))

    if lod == 0:
        # Each length of trunk flares towards its top, leaving the ring scars a palm carries.
        steps = 9
        path, radii = [], []
        for k in range(steps):
            t0, t1 = k / steps, (k + 1) / steps
            path += [stem(t0), stem(t1)]
            radii += [girth(t0) * (1.0 if k == 0 else 0.88), girth(t1) * 1.08]
        root.add("bark", tube(path, radii, 7, top=True).graded(0.82, 1.0).speckle(rng, 0.08))
    else:
        ts = [0.0, 0.5, 1.0] if lod == 2 else [0.0, 0.1, 0.55, 1.0]
        root.add("bark", tube([stem(t) for t in ts], [girth(t) for t in ts], 5 - lod, top=True))

    crown = stem(1.0)
    fronds: list[Mesh] = []
    count, segments = ((14, 8), (8, 3), (5, 1))[lod]
    for k in range(count):
        yaw = (k + rng.uniform(-0.3, 0.3)) * math.tau / count
        layer = k % 3 if lod == 0 else k % 2
        rise = ((66.0, 38.0, 12.0) if lod < 2 else (24.0, -4.0))[layer] + rng.uniform(-7, 7)
        droop = ((100.0, 95.0, 80.0)[layer] if lod < 2 else 0.0) + rng.uniform(-10, 10)
        length = radius * rng.uniform(1.05, 1.25)
        frond = _frond(crown, yaw, rise, droop, length, 0.46 * radius, segments, feathered=lod == 0)
        # The lowest fronds are the oldest: yellower and duller.
        tone = ((1.0, 1.0, 1.0), (0.93, 0.95, 0.82), (0.9, 0.84, 0.55))[layer]
        fronds.append(frond.shade(tone).shade(rng.uniform(0.88, 1.0)))
    if lod == 0:
        for k in range(3):
            yaw = bearing + k * math.tau / 3 + rng.uniform(-0.5, 0.5)
            fronds.append(_frond(crown, yaw, 82.0, 30.0, 0.6 * radius, 0.2 * radius, 3))
        root.add("bark", blob(rng, 0, 0.1).scale(0.32, 0.3, 0.32).move(*crown).shade(0.85))
        for k in range(5):
            a = bearing + k * math.tau / 5
            nut = blob(rng, 0, 0.08).scale(0.17)
            root.add("bark", nut.move(*_polar(crown, a, 0.27, crown[1] - 0.24)).shade(0.5))
    root.add("foliage", Mesh.join(fronds).speckle(rng, 0.1))
    return _tree(root, materials)


def umbrella(seed: int, lod: int) -> Model:
    """Monkeypod: a stout trunk whose limbs fan out under a wide, shallow dome."""
    rng = random.Random(seed)
    height, radius = rng.uniform(9.5, 11.0), rng.uniform(7.0, 8.2)
    lean = (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3))
    fork: Point = (lean[0], 0.32 * height, lean[1])
    root = Node("umbrella")
    materials = _materials(0x66503A, 0x5C9642)
    centre: Point = (lean[0], 0.84 * height, lean[1])
    if lod == 2:
        root.add("bark", tube([(0, 0, 0), centre], [0.7, 0.2], 3))
        root.add(
            "foliage",
            _crown(
                rng, [((centre[0], 0.8 * height, centre[2]), radius, 0.2 * height, 0)], belly=0.4
            ),
        )
        return _tree(root, materials)

    path = [(0.0, 0.0, 0.0), (lean[0] * 0.3, 0.1 * height, lean[1] * 0.3), fork]
    root.add(
        "bark", _trunk(rng, path, [0.9, 0.56, 0.46], 8 if lod == 0 else 4, 1.6 if lod == 0 else 0.0)
    )
    limbs = 6 if lod == 0 else 3
    spin = rng.uniform(0, math.tau)
    lobes: list[Lobe] = [
        (centre, (0.5 if lod == 0 else 0.92) * radius, (0.13 if lod == 0 else 0.16) * height, 1)
    ]
    for k in range(limbs):
        a = spin + (k + rng.uniform(-0.2, 0.2)) * math.tau / limbs
        reach = rng.uniform(0.54, 0.62) * radius
        end = _polar(fork, a, reach, rng.uniform(0.76, 0.81) * height)
        elbow = _polar(fork, a, reach * 0.5, 0.6 * height)
        root.add("bark", tube([fork, elbow, end], [0.32, 0.2, 0.08], 5 if lod == 0 else 3))
        if lod == 0:
            lobes.append(
                (end, rng.uniform(0.38, 0.44) * radius, rng.uniform(0.1, 0.12) * height, 1)
            )
            for turn in (-0.5, 0.5):
                tip = _polar(fork, a + turn, 0.86 * radius, rng.uniform(0.72, 0.76) * height)
                root.add("bark", tube([elbow, tip], [0.11, 0.04], 3))
            rim = _polar(fork, a + math.pi / limbs, 0.84 * radius, rng.uniform(0.73, 0.77) * height)
            lobes.append((rim, rng.uniform(0.22, 0.27) * radius, 0.075 * height, 0))
        else:
            lobes.append(
                (_polar(fork, a, 0.74 * radius, 0.77 * height), 0.3 * radius, 0.09 * height, 0)
            )
    root.parts["bark"] = root.parts["bark"].graded(1.0, 0.7).speckle(rng, 0.08 if lod == 0 else 0.0)
    root.add("foliage", _crown(rng, lobes, belly=0.4, shadow=0.68))
    return _tree(root, materials)


def shrub(seed: int, lod: int) -> Model:
    """A waist-high clump: naupaka, hibiscus hedge, kiawe scrub."""
    rng = random.Random(seed)
    height, radius = rng.uniform(1.5, 2.1), rng.uniform(1.3, 1.7)
    root = Node("shrub")
    lobes: list[Lobe] = [
        ((0.0, 0.34 * height, 0.0), 0.62 * radius, 0.64 * height, 1 if lod == 0 else 0)
    ]
    bearing = rng.uniform(0, math.tau)
    for k in range((5, 2, 0)[lod]):
        a = bearing + (k + rng.uniform(-0.2, 0.2)) * math.tau / (5 if lod == 0 else 2)
        reach = rng.uniform(0.48, 0.62) * radius
        size = rng.uniform(0.34, 0.48)
        at = (reach * math.cos(a), 0.18 * height, reach * math.sin(a))
        lobes.append(
            (at, size * radius, (size + 0.12) * height, 1 if lod == 0 and k % 2 == 0 else 0)
        )
    if lod < 2:
        for k in range(3):
            a = bearing + 1.0 + k * math.tau / 3
            tip = (0.4 * radius * math.cos(a), 0.6 * height, 0.4 * radius * math.sin(a))
            root.add("bark", tube([(0, 0, 0), tip], [0.07, 0.03], 3))

    def grounded(points: Array) -> Array:
        return np.maximum(points, [-np.inf, 0.0, -np.inf])

    # The clump sits into the ground: what would be below it is never seen and is left out.
    crown = _crown(rng, lobes, belly=1.0, shadow=0.66).warp(grounded)
    root.add("foliage", crown.keep(crown.tris[:, :, 1].max(axis=1) > 0.0))
    if "bark" not in root.parts:
        root.add("bark", tube([(0, 0, 0), (0, 0.4 * height, 0)], [0.08, 0.04], 3))
    return _tree(root, _materials(0x6B5138, 0x7BAE46))
