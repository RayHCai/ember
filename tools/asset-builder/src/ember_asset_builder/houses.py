"""Lahaina houses, built to a footprint: `length` along X (the ridge), `width` along Z, front +Z.

Everything stays inside the footprint except eaves and front steps, so a consumer can fit a house
to a surveyed rectangle: the lanai is recessed under the main roof and the carport is the open end
of the same roof.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from . import parts
from .gltf import Model, Node
from .mesh import box, cylinder, face, strut
from .parts import PITCH, PITCH_DEG, Plan

PLINTH = 0.45
STOREY = 2.8
OVERHANG = 0.6
RAKE = 0.4
THICK = 0.14


@dataclass(frozen=True)
class House:
    length: float
    width: float
    storeys: int = 1
    hip: bool = False
    # Share of the enclosed front that is a recessed lanai; the rest is a bay.
    lanai: float = 0.0
    # Metres at the +X end left open as a carport under the same roof.
    carport: float = 0.0
    # A front-facing gable over the bay (or over the middle of the front when there is no lanai).
    cross: bool = False
    solar: str = ""
    car: str = ""
    shed: bool = False
    wall: int = 0xE9E0CC
    roof: int = 0x9A4A3A
    accent: int = 0x7A4A2E
    paint: int = 0xC7CCD1
    seed: int = 1


def _gable_roof(
    node: Node, length: float, width: float, eave: float, lod: int, rng: random.Random
) -> float:
    hx, hz = length / 2 + RAKE, width / 2 + OVERHANG
    low = eave - PITCH * OVERHANG
    edge, ridge = low + THICK, eave + PITCH * width / 2 + THICK
    count = 1 if lod else max(3, round(hz / 1.4))
    for s in (1, -1):
        eave_edge = ((-hx, edge, s * hz), (hx, edge, s * hz))
        node.add("roof", parts.courses(eave_edge, ((-hx, ridge, 0), (hx, ridge, 0)), count, rng))
        fascia = [(-hx, low, s * hz), (hx, low, s * hz), (hx, edge, s * hz), (-hx, edge, s * hz)]
        node.add("trim", face(fascia, (0, 0, s)))
        x = s * hx
        end = [(x, low, -hz), (x, low, hz), (x, edge, hz), (x, ridge, 0), (x, edge, -hz)]
        node.add("wall", face(end, (s, 0, 0)).shade(0.93))
        if lod == 0:
            for z in (-hz, hz):
                rake = strut(
                    (x + s * 0.03, edge - 0.06, z), (x + s * 0.03, ridge - 0.06, 0), 0.07, 0.24
                )
                node.add("trim", rake)
            vent = parts.quad(0.8, 0.5, 0.0).turn("y", 90 * s)
            node.add("dark", vent.move(x + s * 0.02, eave + PITCH * width * 0.22, 0))
    node.add(
        "trim",
        face([(-hx, low, -hz), (hx, low, -hz), (hx, low, hz), (-hx, low, hz)], (0, -1, 0)).shade(
            0.7
        ),
    )
    if lod == 0:
        cap = strut((-hx - 0.04, ridge + 0.02, 0), (hx + 0.04, ridge + 0.02, 0), 0.36, 0.1)
        node.add("roof", cap.shade(0.78))
    return ridge


def _hip_roof(
    node: Node, length: float, width: float, eave: float, lod: int, rng: random.Random
) -> float:
    hx, hz = length / 2 + OVERHANG, width / 2 + OVERHANG
    low = eave - PITCH * OVERHANG
    edge = low + THICK
    ridge, rx = edge + PITCH * hz, max(hx - hz, 0.0)
    count = 1 if lod else max(3, round(hz / 1.4))
    for s in (1, -1):
        side = ((-hx, edge, s * hz), (hx, edge, s * hz))
        node.add("roof", parts.courses(side, ((-rx, ridge, 0), (rx, ridge, 0)), count, rng))
        end = ((s * hx, edge, -hz), (s * hx, edge, hz))
        apex = (s * rx, ridge, 0)
        node.add("roof", parts.courses(end, (apex, apex), count, rng).shade(0.92))
        node.add(
            "trim",
            face(
                [(-hx, low, s * hz), (hx, low, s * hz), (hx, edge, s * hz), (-hx, edge, s * hz)],
                (0, 0, s),
            ),
        )
        node.add(
            "trim",
            face(
                [(s * hx, low, -hz), (s * hx, low, hz), (s * hx, edge, hz), (s * hx, edge, -hz)],
                (s, 0, 0),
            ),
        )
        if lod == 0:
            for z in (-hz, hz):
                hip = strut((s * hx, edge + 0.02, z), (s * rx, ridge + 0.02, 0), 0.26, 0.08)
                node.add("roof", hip.shade(0.8))
    node.add(
        "trim",
        face([(-hx, low, -hz), (hx, low, -hz), (hx, low, hz), (-hx, low, hz)], (0, -1, 0)).shade(
            0.7
        ),
    )
    if lod == 0 and rx > 0.2:
        cap = strut((-rx, ridge + 0.02, 0), (rx, ridge + 0.02, 0), 0.36, 0.1)
        node.add("roof", cap.shade(0.78))
    return ridge


def _cross_gable(
    node: Node, at: float, span: float, width: float, eave: float, lod: int, rng: random.Random
) -> None:
    """A gable facing the front over x = `at`, `span` wide, running back into the main roof."""
    half = span / 2 + OVERHANG
    edge = eave - PITCH * OVERHANG + THICK
    ridge = eave + PITCH * span / 2 + THICK
    back, front = width / 2 - span / 2 - 0.1, width / 2 + OVERHANG
    count = 1 if lod else 3
    for s in (1, -1):
        eave_edge = ((at + s * half, edge, back), (at + s * half, edge, front))
        node.add(
            "roof", parts.courses(eave_edge, ((at, ridge, back), (at, ridge, front)), count, rng)
        )
    gable = [
        (at - half, edge, front + 0.01),
        (at + half, edge, front + 0.01),
        (at, ridge, front + 0.01),
    ]
    node.add("wall", face(gable, (0, 0, 1)).shade(0.93))
    if lod == 0:
        for s in (1, -1):
            rake = strut(
                (at + s * half, edge - 0.06, front + 0.04),
                (at, ridge - 0.06, front + 0.04),
                0.07,
                0.24,
            )
            node.add("trim", rake)
        node.add(
            "roof",
            strut((at, ridge + 0.02, back), (at, ridge + 0.02, front + 0.04), 0.36, 0.1).shade(
                0.78
            ),
        )
        node.add("dark", parts.quad(0.7, 0.45, front + 0.03).move(at, edge + PITCH * span * 0.2))


def _lanai(
    node: Node, a: float, b: float, front: float, depth: float, spec: House, lod: int, bay: bool
) -> float:
    """Posts, rail and steps along the recessed front between x = a and b; returns the door's x."""
    soffit = PLINTH + STOREY * spec.storeys - PITCH * OVERHANG
    node.add(
        "wood",
        box(b - a, 0.06, depth).move((a + b) / 2, PLINTH + 0.03, front - depth / 2).shade(0.95),
    )
    count = max(1, round((b - a) / 2.9))
    xs = [a + 0.1 + k * (b - a - (0.1 if bay else 0.2)) / count for k in range(count + 1)]
    gate = count // 2
    door_x = (xs[gate] + xs[gate + 1]) / 2
    z = front - 0.1
    node.add(
        "concrete",
        parts.steps(min(1.7, xs[gate + 1] - xs[gate] - 0.3), PLINTH, lod).move(door_x, 0, front),
    )
    if lod > 0:
        for x in (xs[0], xs[-1]):
            node.add("trim", parts.post(x, z, PLINTH, soffit, 0.18))
        return door_x
    for x in xs if not bay else xs[:-1]:
        node.add("trim", parts.post(x, z, PLINTH, soffit))
    node.add("trim", strut((a, soffit - 0.1, z), (b, soffit - 0.1, z), 0.12, 0.2))
    levels = range(spec.storeys)
    for level in levels:
        base = PLINTH + level * STOREY
        if level > 0:
            node.add(
                "wood", box(b - a, 0.14, depth).move((a + b) / 2, base - 0.07, front - depth / 2)
            )
        for k in range(count):
            if k == gate and level == 0:
                continue
            node.add("trim", strut((xs[k], base + 0.95, z), (xs[k + 1], base + 0.95, z), 0.08))
            node.add(
                "trim",
                box(xs[k + 1] - xs[k], 0.7, 0.04)
                .move((xs[k] + xs[k + 1]) / 2, base + 0.5, z)
                .shade(0.9),
            )
        node.add(
            "trim", strut((a + 0.08, base + 0.95, front - depth), (a + 0.08, base + 0.95, z), 0.08)
        )
        node.add(
            "trim",
            box(0.04, 0.7, depth - 0.1).move(a + 0.08, base + 0.5, front - depth / 2).shade(0.9),
        )
    return door_x


def _roof_gear(
    node: Node, spec: House, x0: float, x1: float, eave: float, lod: int, rng: random.Random
) -> None:
    def on_slope(piece: parts.Parts, x: float, z: float) -> None:
        y = eave - PITCH * OVERHANG + THICK + PITCH * (spec.width / 2 + OVERHANG - abs(z))
        parts.add(node, parts.tilted(piece, PITCH_DEG if z > 0 else -PITCH_DEG), x, y, z)

    quarter = spec.width / 4 + 0.1
    room = x1 - x0 - (spec.width if spec.hip else 0.0)
    mid = (x0 + x1) / 2
    if spec.solar == "heater" and room > 2.6:
        on_slope(parts.water_heater(lod), mid + 0.2 * room, -quarter)
    if spec.solar == "pv" and room > 3.4:
        columns = min(6, int(room / 1.1))
        rows = 2 if spec.width > 9.5 else 1
        on_slope(parts.solar_array(columns, rows, lod), mid, -quarter)
    if lod == 0:
        for _ in range(2):
            x, z = (
                mid + rng.uniform(-0.4, 0.4) * max(room, 1.0),
                rng.choice((-1, 1)) * quarter * rng.uniform(0.3, 0.6),
            )
            y = eave - PITCH * OVERHANG + THICK + PITCH * (spec.width / 2 + OVERHANG - abs(z))
            node.add("metal", cylinder(5, 0.07, 0.55).move(x, y - 0.05, z))


def house(spec: House, lod: int = 0) -> Model:
    rng = random.Random(spec.seed)
    length, width = spec.length, spec.width
    hx, hz = length / 2, width / 2
    plinth = 0.12 if spec.shed else PLINTH
    eave = plinth + (2.4 if spec.shed else STOREY * spec.storeys)
    x1 = hx - spec.carport
    depth = min(2.4, 0.28 * width) if spec.lanai > 0 else 0.0
    split = -hx + spec.lanai * (x1 + hx)
    main: Plan = (-hx, x1, -hz, hz - depth)
    bay: Plan | None = (split, x1, hz - depth - 0.05, hz) if 0 < spec.lanai < 1 else None
    root = Node("house")

    root.add("foundation", box(x1 + hx, plinth, width).move((x1 - hx) / 2, plinth / 2, 0))
    for plan in (main, bay):
        if plan is None:
            continue
        root.add("wall", parts.walls(plan, plinth, eave))
        if lod == 0:
            for x in plan[:2]:
                for z in plan[2:]:
                    root.add("trim", parts.post(x, z, plinth, eave, 0.16))
    if lod == 0 and spec.storeys > 1:
        belt = box(x1 + hx + 0.1, 0.14, width - depth + 0.1)
        root.add("trim", belt.move((x1 - hx) / 2, plinth + STOREY, -depth / 2))

    ridge = (_hip_roof if spec.hip else _gable_roof)(root, length, width, eave, lod, rng)
    if spec.cross:
        if bay is not None:
            _cross_gable(root, (split + x1) / 2, x1 - split, width, eave, lod, rng)
        else:
            _cross_gable(
                root, (x1 - hx) / 2, min(0.45 * (x1 + hx), width * 0.7), width, eave, lod, rng
            )

    sill = 1.55
    glass = (1.5, 1.25)
    floors = [plinth + k * STOREY for k in range(spec.storeys)]

    def windows(
        plan: Plan,
        side: parts.Side,
        a: float,
        b: float,
        skip: float | None = None,
        pitch: float = 3.3,
    ) -> None:
        for u in parts.spread(a, b, pitch):
            for k, floor in enumerate(floors):
                if skip is not None and k == 0 and abs(u - skip) < 1.4:
                    continue
                shutters = lod == 0 and side == "front" and spec.accent != 0 and rng.random() < 0.5
                piece = parts.window(*glass, lod, shutters=shutters)
                parts.mount(root, piece, side, u, floor + sill, plan)

    if spec.shed:
        parts.mount(root, parts.door(min(2.0, length - 1.2), 2.0, lod), "front", 0.0, plinth, main)
        if lod == 0 and width > 3.4:
            parts.mount(root, parts.window(0.8, 0.7, lod), "right", 0.0, plinth + 1.5, main)
    else:
        door_x: float
        if spec.lanai > 0:
            a, b = -hx, (split if bay is not None else x1)
            door_x = _lanai(root, a, b, hz, depth, spec, lod, bay is not None)
            windows(main, "front", a + 0.3, b - 0.3, skip=door_x, pitch=3.0)
            if spec.storeys > 1:
                parts.mount(
                    root,
                    parts.door(0.95, 2.05, lod, glazed=True),
                    "front",
                    door_x,
                    plinth + STOREY,
                    main,
                )
            if bay is not None:
                wide = parts.window(min(2.6, x1 - split - 1.2), 1.4, lod, panes=3)
                for floor in floors:
                    parts.mount(root, wide, "front", (split + x1) / 2, floor + sill, bay)
        else:
            bays = parts.spread(-hx, x1, 3.3)
            door_x = bays[len(bays) // 2] if bays else 0.0
            windows(main, "front", -hx, x1, skip=door_x)
            root.add("concrete", parts.steps(1.5, plinth, lod).move(door_x, 0, hz))
            if lod == 0:
                hood = box(1.9, 0.08, 1.0).turn("x", 12).move(door_x, plinth + 2.4, hz + 0.5)
                root.add("roof", hood.shade(0.9))
        parts.mount(
            root,
            parts.door(0.95, 2.05, lod, glazed=spec.seed % 2 == 0),
            "front",
            door_x,
            plinth,
            main,
        )
        windows(main, "back", -hx, x1)
        windows(main, "left", -hz, hz - depth)
        if spec.carport > 0:
            side_door = -hz + 0.3 * (width - depth)
            parts.mount(root, parts.door(0.9, 2.05, lod), "right", side_door, plinth, main)
            windows(main, "right", -hz, hz - depth, skip=side_door)
            root.add("concrete", parts.steps(1.2, plinth, lod).turn("y", 90).move(x1, 0, side_door))
        else:
            windows(main, "right", -hz, hz - depth)
        if lod == 0:
            unit = box(0.9, 0.8, 0.45, bevel=0.05).move(-hx + 1.4, 0.4, -hz - 0.35)
            root.add("metal", unit.under(0.75))

    if spec.carport > 0:
        port = spec.carport
        root.add("concrete", box(port, 0.1, width).move(hx - port / 2, 0.05, 0))
        soffit = eave - PITCH * OVERHANG
        rows = [-hz + 0.15, hz - 0.15] if lod or width < 9 else [-hz + 0.15, 0.0, hz - 0.15]
        for z in rows:
            root.add("trim", parts.post(hx - 0.15, z, 0.1, soffit, 0.16))
        if lod == 0:
            root.add(
                "trim",
                strut(
                    (hx - 0.15, soffit - 0.12, -hz + 0.15),
                    (hx - 0.15, soffit - 0.12, hz - 0.15),
                    0.12,
                    0.24,
                ),
            )
        if spec.car:
            vehicle = parts.car(rng, lod, pickup=spec.car == "pickup")
            parts.add(root, vehicle, hx - port / 2 - 0.1, 0.1, rng.uniform(-0.6, 0.6))

    if not spec.shed:
        _roof_gear(root, spec, -hx, hx, eave, lod, rng)

    return Model(
        root,
        parts.materials(spec.wall, spec.roof, spec.accent, spec.paint),
        {
            "kind": "house",
            "lengthM": length,
            "widthM": width,
            "wallHeightM": round(eave, 2),
            "heightM": round(ridge, 2),
        },
    )
