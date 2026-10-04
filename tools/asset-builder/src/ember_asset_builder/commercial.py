"""Flat-roofed town buildings, built to a footprint: `length` is the frontage along X, `width` the
depth along Z, front +Z. Units of the same depth can stand side by side as a street row.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from . import parts
from .gltf import Model, Node
from .mesh import Mesh, box, cylinder, face, loft, rect, strut
from .parts import Plan

KERB = 0.15
GROUND = 3.6
UPPER = 3.1
THICK = 0.3


@dataclass(frozen=True)
class Block:
    length: float
    width: float
    storeys: int = 1
    # shop: timber false front and balcony; store: glazed front and awning; office: ribbon
    # windows; lodge: walkways on every floor; hall: one tall floor with roller doors.
    style: str = "store"
    wall: int = 0xE6DCC6
    roof: int = 0x9B9E9C
    accent: int = 0x2F6F5E
    seed: int = 1


def _cladding(plan: Plan, y0: float, y1: float, pitch: float) -> Mesh:
    """Walls of upright sheets in two alternating tones."""
    xa, xb, za, zb = plan
    corners = [(xb, zb), (xa, zb), (xa, za), (xb, za)]
    sheets = []
    for k, (a, b) in enumerate(zip(corners, [*corners[1:], corners[0]], strict=True)):
        count = max(1, round(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / pitch))
        for i in range(count):
            p = (a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)
            q = (a[0] + (b[0] - a[0]) * (i + 1) / count, a[1] + (b[1] - a[1]) * (i + 1) / count)
            out = (b[1] - a[1], 0.0, a[0] - b[0])
            sheet = face(
                [(p[0], y0, p[1]), (q[0], y0, q[1]), (q[0], y1, q[1]), (p[0], y1, p[1])], out
            )
            sheets.append(sheet.shade(1.0 if (i + k) % 2 else 0.93))
    return Mesh.join(sheets)


def _roof(node: Node, spec: Block, deck: float, top: float, lod: int, rng: random.Random) -> None:
    """Roof deck behind a parapet, with its coping."""
    length, width = spec.length, spec.width
    ix, iz = length / 2 - THICK, width / 2 - THICK
    node.add(
        "wall", loft([rect(2 * ix, 2 * iz, deck), rect(2 * ix, 2 * iz, top)]).flipped().shade(0.8)
    )
    strips = 1 if lod else max(2, round(length / 6))
    node.add(
        "roof",
        parts.courses(
            ((-ix, deck, iz), (-ix, deck, -iz)), ((ix, deck, iz), (ix, deck, -iz)), strips, rng
        ),
    )
    coping = loft([rect(length + 0.14, width + 0.14, top), rect(2 * ix, 2 * iz, top)])
    node.add("trim", coping if coping.normals()[0, 1] > 0 else coping.flipped())
    if lod == 0:
        node.add(
            "trim",
            loft(
                [
                    rect(length + 0.14, width + 0.14, top - 0.16),
                    rect(length + 0.14, width + 0.14, top),
                ]
            ),
        )


def _roof_gear(node: Node, spec: Block, deck: float, lod: int, rng: random.Random) -> None:
    length, width = spec.length, spec.width
    area = length * width
    count = min(3 if lod else 7, max(1, round(area / 120)))
    spots: list[tuple[float, float]] = []
    for _ in range(40):
        if len(spots) == count:
            break
        x, z = rng.uniform(-0.36, 0.36) * length, rng.uniform(-0.36, 0.2) * width
        if all(abs(x - a) > 2.6 or abs(z - b) > 2.2 for a, b in spots):
            spots.append((x, z))
    for x, z in spots:
        parts.add(
            node,
            parts.hvac(rng, lod, 1.0 if area < 500 else 1.5),
            x,
            deck,
            z,
            rng.choice((0.0, 90.0)),
        )
    if lod > 0:
        return
    if spec.style == "hall":
        for z in parts.spread(-width / 2, width / 2, 9.0):
            for x in parts.spread(-length / 2, length / 2, 6.5):
                light = loft([rect(1.3, 2.6, 0.0), rect(0.9, 2.2, 0.3)], top=True)
                node.add("glass", light.move(x, deck, z).under(0.8))
    else:
        node.add("metal", box(1.0, 0.25, 1.0).move(length * 0.4 - 0.8, deck + 0.125, width * 0.36))
        for _ in range(2):
            pipe = cylinder(5, 0.09, 0.8).move(
                rng.uniform(-0.4, 0.4) * length, deck, rng.uniform(0.25, 0.4) * width
            )
            node.add("metal", pipe)


def _awning(
    node: Node, a: float, b: float, y: float, z: float, reach: float, drop: float, striped: bool
) -> None:
    """Sloped canopy along the front from x = a to b; `striped` alternates the accent with white."""
    count = max(2, round((b - a) / 0.9)) if striped else 1
    for k in range(count):
        x0, x1 = a + (b - a) * k / count, a + (b - a) * (k + 1) / count
        strip = [(x0, y, z), (x1, y, z), (x1, y - drop, z + reach), (x0, y - drop, z + reach)]
        node.add("accent" if k % 2 == 0 else "trim", face(strip, (0, 1, 0)))
    edge = [
        (a, y - drop - 0.22, z + reach),
        (b, y - drop - 0.22, z + reach),
        (b, y - drop, z + reach),
        (a, y - drop, z + reach),
    ]
    node.add("accent", face(edge, (0, 0, 1)).shade(0.85))
    under = [
        (a, y - drop - 0.01, z + reach),
        (b, y - drop - 0.01, z + reach),
        (b, y - 0.01, z),
        (a, y - 0.01, z),
    ]
    node.add("accent", face(under, (0, -1, 0)).shade(0.55))


def _shop_front(node: Node, spec: Block, plan: Plan, top: float, lod: int) -> None:
    """Front Street timber shop: false front, balcony on posts over the pavement."""
    hx, hz = spec.length / 2, spec.width / 2
    deck = KERB + GROUND
    node.add("wall", box(spec.length, 0.9, THICK).move(0, top + 0.45, hz - THICK / 2))
    node.add("wall", box(spec.length * 0.5, 0.6, THICK).move(0, top + 1.2, hz - THICK / 2))
    node.add("accent", parts.quad(spec.length * 0.42, 0.7, hz + 0.02).move(0, top + 0.75))
    if lod == 0:
        node.add(
            "trim", box(spec.length + 0.2, 0.1, THICK + 0.16).move(0, top + 0.95, hz - THICK / 2)
        )
        node.add(
            "trim",
            box(spec.length * 0.5 + 0.2, 0.1, THICK + 0.16).move(0, top + 1.55, hz - THICK / 2),
        )
    parts.mount(node, parts.door(1.5, 2.3, lod, glazed=True), "front", 0.0, KERB, plan)
    side = (spec.length - 2.6) / 2
    for s in (-1, 1):
        parts.mount(
            node, parts.shopfront(side - 0.6, 2.5, lod), "front", s * (1.3 + side / 2), KERB, plan
        )
    reach = 1.6
    node.add("wood", box(spec.length, 0.16, reach).move(0, deck - 0.08, hz + reach / 2))
    count = max(2, round(spec.length / 3.2))
    xs = [-hx + 0.12 + k * (spec.length - 0.24) / count for k in range(count + 1)]
    z = hz + reach - 0.1
    for x in xs if lod == 0 else (xs[0], xs[-1]):
        node.add("trim", parts.post(x, z, KERB, deck + 2.45, 0.15))
    slope = [
        (-hx - 0.1, deck + 2.9, hz),
        (hx + 0.1, deck + 2.9, hz),
        (hx + 0.1, deck + 2.4, hz + reach + 0.25),
        (-hx - 0.1, deck + 2.4, hz + reach + 0.25),
    ]
    node.add("roof", face(slope, (0, 1, 0)).shade(0.9))
    node.add("trim", face([(p[0], p[1] - 0.02, p[2]) for p in slope], (0, -1, 0)).shade(0.6))
    for u in parts.spread(-hx, hx, 3.6):
        parts.mount(node, parts.door(1.1, 2.1, lod, glazed=True), "front", u, deck, plan)
    if lod == 0:
        node.add("trim", strut((-hx, deck + 0.95, z), (hx, deck + 0.95, z), 0.08))
        node.add("trim", box(spec.length, 0.7, 0.04).move(0, deck + 0.5, z).shade(0.9))
        for x in (-hx + 0.05, hx - 0.05):
            node.add("trim", box(0.04, 0.8, reach).move(x, deck + 0.55, hz + reach / 2).shade(0.9))


def _store_front(node: Node, spec: Block, plan: Plan, top: float, lod: int) -> None:
    hx, hz = spec.length / 2, spec.width / 2
    bays = max(1, round((spec.length - 1.0) / 4.5))
    span = (spec.length - 1.0) / bays
    door_bay = bays // 2
    for k in range(bays):
        u = -hx + 0.5 + (k + 0.5) * span
        if k == door_bay:
            parts.mount(node, parts.door(1.6, 2.4, lod, glazed=True), "front", u, KERB, plan)
            if span > 3.4 and lod == 0:
                for s in (-1, 1):
                    parts.mount(
                        node,
                        parts.shopfront((span - 2.4) / 2, 2.6, lod),
                        "front",
                        u + s * (0.8 + (span - 1.6) / 4),
                        KERB,
                        plan,
                    )
        else:
            parts.mount(node, parts.shopfront(span - 0.7, 2.6, lod), "front", u, KERB, plan)
    _awning(node, -hx + 0.3, hx - 0.3, KERB + 3.25, hz, 1.4, 0.5, striped=lod == 0)
    node.add("accent", parts.quad(spec.length * 0.6, 0.6, hz + 0.03).move(0, top - 0.55).shade(0.8))


def _office_front(node: Node, spec: Block, plan: Plan, lod: int) -> None:
    hx, hz = spec.length / 2, spec.width / 2
    parts.mount(node, parts.door(2.2, 2.5, lod, glazed=True), "front", 0.0, KERB, plan)
    node.add("trim", box(4.0, 0.16, 1.8).move(0, KERB + 2.95, hz + 0.9))
    if lod == 0:
        for s in (-1, 1):
            node.add("trim", parts.post(s * 1.8, hz + 1.65, KERB, KERB + 2.87, 0.16))
    for level in range(spec.storeys):
        base = KERB + (0 if level == 0 else GROUND + (level - 1) * UPPER)
        for u in parts.spread(-hx, hx, 3.0):
            if level == 0 and abs(u) < 2.4:
                continue
            parts.mount(node, parts.window(2.0, 1.5, lod, panes=3), "front", u, base + 1.75, plan)
        if lod == 0:
            fin = box(spec.length - 0.6, 0.08, 0.5).move(0, base + 2.75, hz + 0.25)
            node.add("accent", fin)


def _lodge_front(node: Node, spec: Block, plan: Plan, top: float, lod: int) -> None:
    hx, hz = spec.length / 2, spec.width / 2
    reach = 1.3
    tower = 3.2
    bays = parts.spread(-hx + tower, hx, 3.8)
    z = hz + reach - 0.08
    for level in range(spec.storeys):
        base = KERB + (0 if level == 0 else GROUND + (level - 1) * UPPER)
        for u in bays:
            if lod == 0:
                parts.mount(node, parts.door(0.9, 2.05, lod), "front", u - 0.9, base, plan)
            parts.mount(
                node, parts.window(1.3, 1.2, lod, sill=False), "front", u + 0.7, base + 1.6, plan
            )
        if level > 0:
            node.add(
                "concrete",
                box(spec.length - tower, 0.18, reach).move(tower / 2, base - 0.09, hz + reach / 2),
            )
            node.add(
                "trim",
                box(spec.length - tower, 0.95, 0.06).move(tower / 2, base + 0.5, z).shade(0.92),
            )
    node.add(
        "concrete",
        box(spec.length - tower, 0.14, reach + 0.3).move(
            tower / 2, top - 0.5, hz + reach / 2 + 0.15
        ),
    )
    if lod == 0:
        for u in parts.spread(-hx + tower, hx, 3.8):
            node.add("trim", parts.post(u + 1.9 - 0.1, z, KERB, top - 0.57, 0.16))
    node.add(
        "wall",
        parts.walls((-hx, -hx + tower, hz - 0.05, hz + reach + 0.6), KERB, top + 1.6).shade(0.94),
    )
    node.add(
        "trim",
        box(tower + 0.14, 0.14, reach + 0.79).move(
            -hx + tower / 2, top + 1.67, hz + reach / 2 + 0.275
        ),
    )
    for level in range(spec.storeys):
        base = KERB + (0 if level == 0 else GROUND + (level - 1) * UPPER)
        node.add(
            "dark",
            parts.quad(1.2, 2.1, 0.02)
            .turn("y", 90)
            .move(-hx + tower, base + 1.2, hz + reach / 2 + 0.2),
        )


def _hall_front(node: Node, spec: Block, plan: Plan, lod: int) -> None:
    hx, hz = spec.length / 2, spec.width / 2
    doors = parts.spread(-hx + 3.0, hx, 8.0)
    for u in doors:
        parts.mount(node, parts.roller_door(4.2, 4.4, lod), "front", u, KERB, plan)
    parts.mount(node, parts.door(1.0, 2.1, lod), "front", -hx + 1.6, KERB, plan)
    if doors:
        a, b = doors[0] - 2.8, doors[-1] + 2.8
        node.add("metal", box(b - a, 0.14, 2.2).move((a + b) / 2, KERB + 4.95, hz + 1.1).shade(0.9))
    for u in parts.spread(-hx, hx, 5.0):
        parts.mount(node, parts.window(2.6, 0.8, lod, panes=3), "front", u, KERB + 5.6, plan)


def block(spec: Block, lod: int = 0) -> Model:
    rng = random.Random(spec.seed)
    length, width = spec.length, spec.width
    hx, hz = length / 2, width / 2
    hall = spec.style == "hall"
    deck = KERB + (6.4 if hall else GROUND + UPPER * (spec.storeys - 1))
    top = deck + (0.5 if hall else 0.8)
    plan: Plan = (-hx, hx, -hz, hz)
    root = Node("block")
    root.add("concrete", box(length + 0.5, KERB, width + 0.5).move(y=KERB / 2))
    if hall and lod == 0:
        root.add("wall", _cladding(plan, KERB, top, 1.6))
    else:
        root.add("wall", parts.walls(plan, KERB, top, dado=1.0))
    _roof(root, spec, deck, top, lod, rng)
    _roof_gear(root, spec, deck, lod, rng)

    if spec.style == "shop":
        _shop_front(root, spec, plan, top, lod)
    elif spec.style == "office":
        _office_front(root, spec, plan, lod)
    elif spec.style == "lodge":
        _lodge_front(root, spec, plan, top, lod)
    elif hall:
        _hall_front(root, spec, plan, lod)
    else:
        _store_front(root, spec, plan, top, lod)

    for level in range(1 if hall else spec.storeys):
        base = KERB + (0 if level == 0 else GROUND + (level - 1) * UPPER)
        y = base + (5.6 if hall else 1.75)
        size = (2.6, 0.8) if hall else (1.4, 1.5)
        for side in ("left", "right"):
            for u in parts.spread(-hz, hz, 5.0 if level == 0 else 3.8):
                parts.mount(root, parts.window(*size, lod, sill=False), side, u, y, plan)
        for u in parts.spread(-hx, hx, 4.2):
            if level == 0 and abs(u - (hx - 2.2)) < 2.6:
                continue
            parts.mount(root, parts.window(*size, lod, sill=False), "back", u, y, plan)
    parts.mount(root, parts.door(1.0, 2.1, lod), "back", -(hx - 1.4), KERB, plan)
    if length > 11 and not hall:
        parts.mount(root, parts.roller_door(2.6, 2.8, lod), "back", -(hx - 4.0), KERB, plan)
    if lod == 0:
        for x in (-hx + 0.4, hx - 0.4):
            root.add(
                "metal", strut((x, KERB, -hz - 0.08), (x, top - 0.2, -hz - 0.08), 0.12, ends=False)
            )
        unit = box(1.0, 0.9, 0.5, bevel=0.05).move(hx * 0.3, KERB + 0.45, -hz - 0.4)
        root.add("metal", unit.under(0.75))

    return Model(
        root,
        parts.materials(spec.wall, spec.roof, spec.accent),
        {
            "kind": "block",
            "lengthM": length,
            "widthM": width,
            "wallHeightM": round(deck, 2),
            "heightM": round(top, 2),
        },
    )
