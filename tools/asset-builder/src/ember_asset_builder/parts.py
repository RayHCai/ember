"""Pieces every building is assembled from: walls, openings, roof gear, a parked car.

Wall pieces are built facing +Z on the wall plane z = 0 and hung with `mount`. `lod` 0 is the full
piece; `lod` 1 is the few faces that still read from far away.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from typing import Literal

import numpy as np

from .gltf import Material, Node
from .mesh import Array, Mesh, box, cap, cylinder, face, lathe, loft, panel, rect, ring, strut

Side = Literal["front", "back", "left", "right"]
# A building's plan: x from, x to, z from, z to.
Plan = tuple[float, float, float, float]
Parts = dict[str, Mesh]
# The two ends of a roof edge.
Edge = tuple[Sequence[float], Sequence[float]]


def materials(wall: int, roof: int, accent: int, paint: int = 0xC7CCD1) -> dict[str, Material]:
    """`wall` and `roof` are the two a consumer recolours per building."""
    return {
        "wall": Material(wall),
        "roof": Material(roof, roughness=0.75),
        "trim": Material(0xF4F1E8),
        "accent": Material(accent, roughness=0.7),
        "glass": Material(0x2F5470, roughness=0.2),
        "foundation": Material(0x85847E),
        "concrete": Material(0xB9B7AE),
        "wood": Material(0x94714E),
        "metal": Material(0xAEB5BA, roughness=0.5),
        "dark": Material(0x34383C),
        "panel": Material(0x1D3152, roughness=0.3),
        "paint": Material(paint, roughness=0.4),
        "rubber": Material(0x1D1E21),
        "lamp": Material(0xF6E7B4),
    }


def mount(node: Node, parts: Parts, side: Side, along: float, y: float, plan: Plan) -> None:
    """Hang parts on one wall of `plan`: `along` is x on the front and back, z on the sides."""
    xa, xb, za, zb = plan
    yaw, x, z = {
        "front": (0.0, along, zb),
        "back": (180.0, along, za),
        "right": (90.0, xb, along),
        "left": (-90.0, xa, along),
    }[side]
    for material, mesh in parts.items():
        node.add(material, mesh.turn("y", yaw).move(x, y, z))


def spread(a: float, b: float, pitch: float) -> list[float]:
    """Centres of as many evenly spaced bays as fit between `a` and `b`, about `pitch` apart."""
    count = max(0, round((b - a) / pitch))
    return [a + (k + 0.5) * (b - a) / count for k in range(count)]


def walls(plan: Plan, y0: float, y1: float, *, dado: float = 0.9) -> Mesh:
    """Four walls with a slightly darker band along the bottom, open above and below."""
    xa, xb, za, zb = plan
    at = ((xa + xb) / 2, (za + zb) / 2)
    rings = [rect(xb - xa, zb - za, y, at=at) for y in (y0, y0 + dado, y1)]
    return Mesh.join([loft(rings[:2]).shade(0.88), loft(rings[1:])])


def quad(w: float, h: float, z: float) -> Mesh:
    """An upright w by h rectangle facing +Z, `z` proud of the wall."""
    x, y = w / 2, h / 2
    return face([(-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)], (0.0, 0.0, 1.0))


def window(
    w: float, h: float, lod: int, *, shutters: bool = False, panes: int = 2, sill: bool = True
) -> Parts:
    if lod > 0:
        return {"glass": quad(w, h, 0.04)}
    trim = [panel(w + 0.22, h + 0.22, 0.07), quad(w, 0.06, 0.1)]
    if sill:
        trim.append(box(w + 0.42, 0.07, 0.17).move(y=-h / 2 - 0.13, z=0.085))
    trim += [quad(0.06, h, 0.1).move(x=w * (k / panes - 0.5)) for k in range(1, panes)]
    parts: Parts = {"trim": Mesh.join(trim), "glass": quad(w, h, 0.085).graded(0.8, 1.0)}
    if shutters:
        parts["accent"] = Mesh.join(
            [panel(0.36, h + 0.1, 0.05).move(x=s * (w / 2 + 0.31)) for s in (-1, 1)]
        )
    return parts


def door(w: float, h: float, lod: int, *, glazed: bool = False) -> Parts:
    """Door with its foot on y = 0."""
    if lod > 0:
        return {"accent": quad(w, h, 0.04).move(y=h / 2)}
    parts: Parts = {
        "trim": panel(w + 0.24, h + 0.12, 0.07).move(y=h / 2 + 0.06),
        "accent": panel(w, h, 0.11).move(y=h / 2),
        "metal": box(0.06, 0.12, 0.05).move(w / 2 - 0.13, h * 0.48, 0.13),
    }
    if glazed:
        parts["glass"] = quad(w * 0.62, h * 0.42, 0.12).move(y=h * 0.68)
    return parts


def roller_door(w: float, h: float, lod: int) -> Parts:
    """Slatted steel door with its foot on y = 0."""
    if lod > 0:
        return {"metal": quad(w, h, 0.04).move(y=h / 2).shade(0.8)}
    slats = max(3, round(h / 0.45))
    rows = [
        quad(w, h / slats, 0.06).move(y=(k + 0.5) * h / slats).shade(0.86 if k % 2 else 0.74)
        for k in range(slats)
    ]
    return {"metal": Mesh.join(rows), "trim": panel(w + 0.3, h + 0.15, 0.05).move(y=h / 2 + 0.075)}


def shopfront(w: float, h: float, lod: int) -> Parts:
    """Display glazing from a low stall riser up, with its foot on y = 0."""
    riser = 0.45
    if lod > 0:
        return {"glass": quad(w, h - riser, 0.04).move(y=riser + (h - riser) / 2)}
    bays = max(1, round(w / 1.7))
    bars = [
        quad(0.07, h - riser, 0.1).move(w * (k / bays - 0.5), riser + (h - riser) / 2)
        for k in range(bays + 1)
    ]
    bars.append(quad(w, 0.07, 0.1).move(y=h * 0.78))
    return {
        "glass": quad(w, h - riser, 0.08).move(y=riser + (h - riser) / 2).graded(0.78, 1.0),
        "trim": Mesh.join([panel(w + 0.16, h + 0.08, 0.06).move(y=h / 2 + 0.04), *bars]),
        "accent": quad(w, riser, 0.09).move(y=riser / 2),
    }


def courses(eave: Edge, ridge: Edge, count: int, rng: random.Random) -> Mesh:
    """A roof plane from its eave edge up to its ridge edge, laid in courses of uneven tone."""
    a0, a1 = (np.asarray(p, dtype=np.float64) for p in eave)
    b0, b1 = (np.asarray(p, dtype=np.float64) for p in ridge)
    rows = []
    for k in range(count):
        t0, t1 = k / count, (k + 1) / count
        points = [
            a0 + (b0 - a0) * t0,
            a1 + (b1 - a1) * t0,
            a1 + (b1 - a1) * t1,
            a0 + (b0 - a0) * t1,
        ]
        tone = 1.0 - 0.05 * (k % 2) - 0.05 * rng.random()
        rows.append(face(np.array(points), (0.0, 1.0, 0.0)).shade(tone))
    return Mesh.join(rows)


def hvac(rng: random.Random, lod: int, size: float = 1.0) -> Parts:
    """Rooftop air handler standing on y = 0."""
    w, d, h = (
        size * rng.uniform(1.3, 1.9),
        size * rng.uniform(1.0, 1.3),
        size * rng.uniform(0.7, 1.0),
    )
    if lod > 0:
        return {"metal": box(w, h, d).move(y=h / 2).under(0.8)}
    return {
        "metal": box(w, h, d, bevel=0.08 * size).move(y=0.14 + h / 2).under(0.75),
        "dark": Mesh.join(
            [
                box(w * 0.9, 0.14, d * 0.9).move(y=0.07),
                cap(ring(8, 0.36 * min(w, d), 0.0), up=True).move(-w * 0.18, 0.15 + h, 0),
                quad(w * 0.3, h * 0.5, d / 2 + 0.01).move(w * 0.25, 0.14 + h * 0.5),
            ]
        ),
    }


def solar_array(columns: int, rows: int, lod: int) -> Parts:
    """Photovoltaic panels lying flat on y = 0, centred; tilt and move it onto a roof."""
    w, d, gap = 1.0, 1.65, 0.05
    span = (columns * (w + gap) - gap, rows * (d + gap) - gap)
    if lod > 0:
        return {"panel": box(span[0], 0.06, span[1]).move(y=0.1)}
    tiles = []
    for c in range(columns):
        for r in range(rows):
            at = (-span[0] / 2 + w / 2 + c * (w + gap), 0.1, -span[1] / 2 + d / 2 + r * (d + gap))
            tiles.append(box(w, 0.05, d).move(*at).shade(0.86 + 0.14 * ((c + r) % 2)))
    return {
        "panel": Mesh.join(tiles),
        "metal": box(span[0] + 0.1, 0.05, span[1] + 0.1).move(y=0.045),
    }


def water_heater(lod: int) -> Parts:
    """Rooftop solar water heater lying flat on y = 0: two collectors below their tank."""
    if lod > 0:
        return {"panel": box(2.1, 0.08, 1.9).move(y=0.1)}
    tank = lathe([(0.0, 0.0), (0.24, 0.06), (0.24, 2.0), (0.0, 2.06)], 8)
    return {
        "panel": Mesh.join([box(1.0, 0.07, 1.9).move(x, 0.1, 0.0) for x in (-0.54, 0.54)]),
        "metal": Mesh.join(
            [box(2.2, 0.05, 2.0).move(y=0.045), tank.turn("z", 90).move(1.03, 0.36, -1.1)]
        ).under(0.8),
    }


def car(rng: random.Random, lod: int, *, pickup: bool = False, material: str = "paint") -> Parts:
    """A parked car standing on y = 0, nose towards +Z."""
    length, width = (5.0, 1.85) if pickup else (4.3, 1.75)
    if lod > 0:
        body = box(width, 0.75, length).move(y=0.62)
        cabin = box(width * 0.86, 0.5, length * 0.4).move(y=1.22, z=-0.1)
        return {material: Mesh.join([body, cabin.shade(0.5)])}
    hx, hz = width / 2, length / 2
    sill, belt = 0.3, 0.92

    def sloped(p: Array) -> Array:
        """Drops the bonnet towards the nose."""
        p = p.copy()
        nose = np.clip((p[:, 2] - hz * 0.45) / (hz * 0.55), 0.0, 1.0)
        p[:, 1] -= 0.16 * nose * (p[:, 1] > 0.7)
        return p

    body = loft(
        [
            rect(width * 0.9, length * 0.95, sill),
            rect(width, length, 0.52),
            rect(width, length, 0.76),
            rect(width * 0.93, length * 0.97, belt),
        ],
        bottom=True,
        top=True,
    ).warp(sloped)
    z0, z1 = (0.1, hz * 0.55) if pickup else (-hz * 0.62, hz * 0.4)
    base = rect(width * 0.92, z1 - z0, belt, at=(0.0, (z0 + z1) / 2))
    top = rect(width * 0.76, (z1 - z0) * 0.62, belt + 0.5, at=(0.0, (z0 + z1) / 2 - 0.08))
    parts: Parts = {
        material: Mesh.join([body.under(0.7), cap(top, up=True)]),
        "glass": loft([base, top]).shade(0.9),
        "trim": Mesh.join(
            [box(0.34, 0.12, 0.04).move(s * hx * 0.62, 0.7, hz * 0.985) for s in (-1, 1)]
        ),
    }
    if pickup:
        bed = loft([rect(width * 0.84, hz * 0.9, belt), rect(width * 0.84, hz * 0.9, belt - 0.42)])
        parts["dark"] = Mesh.join(
            [bed.flipped(), cap(rect(width * 0.84, hz * 0.9, belt - 0.42), up=True)]
        ).move(z=-hz * 0.5)
    wheels = []
    for sx in (-1, 1):
        for z in (-hz * 0.62, hz * 0.62):
            wheel = cylinder(8, 0.34, 0.24).turn("z", 90)
            wheels.append(wheel.move(sx * (hx - 0.1) + 0.12, 0.34, z))
    parts["rubber"] = Mesh.join(wheels)
    return parts


def add(
    node: Node, parts: Parts, x: float = 0.0, y: float = 0.0, z: float = 0.0, yaw: float = 0.0
) -> None:
    for material, mesh in parts.items():
        node.add(material, mesh.turn("y", yaw).move(x, y, z))


def tilted(parts: Parts, deg: float) -> Parts:
    """Parts lying on y = 0 pitched about X, to lie on a roof slope."""
    return {material: mesh.turn("x", deg) for material, mesh in parts.items()}


def steps(w: float, rise: float, lod: int, tread: float = 0.3) -> Mesh:
    """Steps down from height `rise` at z = 0 to the ground, running out towards +Z."""
    count = max(1, round(rise / 0.18))
    if lod > 0:
        return box(w, rise / 2, count * tread).move(y=rise / 4, z=count * tread / 2)
    parts = []
    for k in range(count):
        h = rise * (count - k) / (count + 1)
        parts.append(box(w, h, tread).move(y=h / 2, z=(k + 0.5) * tread))
    return Mesh.join(parts)


def post(x: float, z: float, y0: float, y1: float, w: float = 0.14) -> Mesh:
    return strut((x, y0, z), (x, y1, z), w, ends=False)


PITCH = math.tan(math.radians(23))
PITCH_DEG = 23.0
