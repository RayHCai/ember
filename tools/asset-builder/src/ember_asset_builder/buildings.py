"""A small kit of Lahaina buildings and the ruin one leaves behind.

Each stands on the origin with its front facing +Z; `lengthM` (along X) and `widthM` (along Z) in
its extras are the walls' footprint, so a consumer can fit it to a surveyed one.
"""

from __future__ import annotations

import math
import random
from typing import Literal

from .gltf import Material, Model, Node
from .mesh import Mesh, blob, box, cap, cylinder, face, loft, rect, ring, slab

Side = Literal["front", "back", "left", "right"]
_YAW: dict[Side, float] = {"front": 0.0, "right": 90.0, "back": 180.0, "left": -90.0}
_PLINTH = 0.4
_PITCH = math.tan(math.radians(26))


def _palette(wall: int, roof: int, door: int) -> dict[str, Material]:
    return {
        "wall": Material(wall),
        "roof": Material(roof, roughness=0.8),
        "trim": Material(0xF3EFE4),
        "door": Material(door, roughness=0.7),
        "glass": Material(0x27475F, roughness=0.2),
        "foundation": Material(0x8F8D86),
        "wood": Material(0x8A6A4A),
        "metal": Material(0xAEB5BA, roughness=0.5),
        "panel": Material(0x1C2F4A, roughness=0.3),
    }


def _fit(
    node: Node,
    parts: dict[str, Mesh],
    side: Side,
    along: float,
    y: float,
    size: tuple[float, float],
) -> None:
    """Hang parts built facing +Z at the origin on one wall of a (length, width) footprint."""
    length, width = size
    out = (width if side in ("front", "back") else length) / 2
    for material, mesh in parts.items():
        node.add(material, mesh.move(along, y, out).turn("y", _YAW[side]))


def _window(w: float, h: float) -> dict[str, Mesh]:
    return {
        "trim": Mesh.join(
            [
                box(w + 0.2, h + 0.2, 0.08).move(z=0.03),
                box(0.07, h, 0.05).move(z=0.1),
                box(w, 0.07, 0.05).move(z=0.1),
            ]
        ),
        "glass": box(w, h, 0.06).move(z=0.07),
    }


def _door(w: float, h: float) -> dict[str, Mesh]:
    return {
        "trim": box(w + 0.22, h + 0.11, 0.08).move(y=0.055, z=0.03),
        "door": box(w, h, 0.07).move(z=0.07),
        "metal": box(0.07, 0.07, 0.06).move(x=w / 2 - 0.14, z=0.12),
    }


def _gable_roof(node: Node, size: tuple[float, float], eave_y: float) -> float:
    """Two pitched slabs over the walls, and the wall triangles under them; returns ridge height."""
    length, width = size
    overhang, rake, thick = 0.55, 0.4, 0.14
    ridge = eave_y + _PITCH * width / 2
    low = eave_y - _PITCH * overhang + thick
    x = length / 2 + rake
    for z in (1, -1):
        edge = z * (width / 2 + overhang)
        top, rest = slab(
            [(-x, low, edge), (x, low, edge), (x, ridge + thick, 0), (-x, ridge + thick, 0)], thick
        )
        node.add("roof", top.speckle(random.Random(z), 0.05))
        node.add("trim", rest)
    for end in (1, -1):
        gable = [(end * length / 2, eave_y, -width / 2), (end * length / 2, eave_y, width / 2)]
        node.add("wall", face([*gable, (end * length / 2, ridge, 0)], (end, 0, 0)))
    node.add("roof", box(2 * x + 0.06, 0.1, 0.4).move(y=ridge + thick + 0.02).shade(0.8))
    return ridge + thick


def _hip_roof(node: Node, size: tuple[float, float], eave_y: float) -> float:
    length, width = size
    overhang, fascia = 0.6, 0.16
    hx, hz = length / 2 + overhang, width / 2 + overhang
    low = eave_y - _PITCH * overhang
    top = low + fascia
    ridge, rx = top + _PITCH * hz, (length - width) / 2
    node.add("trim", loft([rect(2 * hx, 2 * hz, low), rect(2 * hx, 2 * hz, top)]))
    node.add("trim", cap(rect(2 * hx, 2 * hz, low), up=False).shade(0.7))
    for z in (1, -1):
        plane = [(-hx, top, z * hz), (hx, top, z * hz), (rx, ridge, 0), (-rx, ridge, 0)]
        node.add("roof", face(plane, (0, 1, z)))
    for x in (1, -1):
        hip = [(x * hx, top, hz), (x * hx, top, -hz), (x * rx, ridge, 0)]
        node.add("roof", face(hip, (x, 1, 0)).shade(0.9))
    return ridge


def _walls(node: Node, size: tuple[float, float], height: float) -> None:
    length, width = size
    node.add("foundation", box(length + 0.12, _PLINTH, width + 0.12).move(y=_PLINTH / 2))
    node.add("wall", box(length, height, width).move(y=_PLINTH + height / 2))


def house_gable() -> Model:
    """Single-storey plantation house: gable roof, a lanai across the front, solar water heater."""
    size = (11.0, 7.6)
    length, width = size
    eave = _PLINTH + 2.8
    root = Node("house_gable")
    _walls(root, size, 2.8)
    ridge = _gable_roof(root, size, eave)

    sill = _PLINTH + 1.65
    _fit(root, _door(1.0, 2.1), "front", -1.0, _PLINTH + 1.05, size)
    for x in (-3.9, 2.6):
        _fit(root, _window(1.6, 1.3), "front", x, sill, size)
    for x in (-3.4, 0.0, 3.4):
        _fit(root, _window(1.4, 1.2), "back", x, sill, size)
    for side in ("left", "right"):
        _fit(root, _window(1.4, 1.2), side, -1.4, sill, size)
        _fit(root, _window(0.8, 0.8), side, 1.8, sill + 0.2, size)

    front, deep = width / 2, 2.1
    x0, x1 = -3.6, 1.6
    root.add("wood", box(x1 - x0, 0.3, deep).move((x0 + x1) / 2, _PLINTH - 0.17, front + deep / 2))
    root.add("foundation", box(1.6, 0.2, 0.45).move(-1.0, 0.1, front + deep + 0.22))
    top, rest = slab(
        [
            (x0 - 0.2, 2.9, front),
            (x1 + 0.2, 2.9, front),
            (x1 + 0.2, 2.62, front + deep + 0.25),
            (x0 - 0.2, 2.62, front + deep + 0.25),
        ],
        0.1,
    )
    root.add("roof", top)
    root.add("trim", rest)
    posts = (x0 + 0.1, -1.9, -0.1, x1 - 0.1)
    for x in posts:
        root.add("trim", box(0.14, 2.24, 0.14).move(x, _PLINTH + 1.12, front + deep - 0.1))
    for a, b in ((posts[0], posts[1]), (posts[2], posts[3])):
        root.add(
            "trim", box(b - a, 0.07, 0.07).move((a + b) / 2, _PLINTH + 0.9, front + deep - 0.1)
        )
    for x in (posts[0], posts[3]):
        root.add(
            "trim", box(0.07, 0.07, deep - 0.1).move(x, _PLINTH + 0.9, front + deep / 2 - 0.05)
        )

    # Rooftop solar water heater on the back slope, as most Lahaina houses carried.
    pitch = math.degrees(math.atan(_PITCH))
    at = (2.2, eave + _PITCH * width / 4 + 0.22, -width / 4)
    root.add("panel", box(2.2, 0.08, 1.3).turn("x", -pitch).move(*at))
    root.add(
        "metal", cylinder(8, 0.24, 1.9).turn("z", 90).move(at[0] + 0.95, at[1] + 0.52, at[2] + 0.75)
    )
    return Model(
        root,
        _palette(0xDCD2BA, 0x8C4A3B, 0x7A4A2E),
        {
            "lengthM": length,
            "widthM": width,
            "eaveHeightM": round(eave, 2),
            "ridgeHeightM": round(ridge, 2),
        },
    )


def house_hip() -> Model:
    """Single-storey house with a hip roof, a front stoop and a carport on its right."""
    size = (9.6, 8.0)
    length, width = size
    eave = _PLINTH + 2.8
    root = Node("house_hip")
    _walls(root, size, 2.8)
    ridge = _hip_roof(root, size, eave)

    sill = _PLINTH + 1.65
    _fit(root, _door(1.0, 2.1), "front", 1.2, _PLINTH + 1.05, size)
    _fit(root, _window(2.4, 1.4), "front", -2.2, sill, size)
    for x in (-2.8, 1.2):
        _fit(root, _window(1.4, 1.2), "back", x, sill, size)
    _fit(root, _door(0.9, 2.1), "back", 3.6, _PLINTH + 1.05, size)
    for side in ("left", "right"):
        for z in (-2.0, 2.0):
            _fit(root, _window(1.3, 1.2), side, z, sill, size)

    front = width / 2
    root.add(
        "foundation", box(2.2, _PLINTH - 0.03, 1.3).move(1.2, _PLINTH / 2 - 0.015, front + 0.65)
    )
    root.add("foundation", box(1.8, _PLINTH / 2, 0.4).move(1.2, _PLINTH / 4, front + 1.5))
    top, rest = slab(
        [
            (-0.1, 2.95, front),
            (2.5, 2.95, front),
            (2.5, 2.75, front + 1.5),
            (-0.1, 2.75, front + 1.5),
        ],
        0.1,
    )
    root.add("roof", top)
    root.add("trim", rest)
    for x in (0.0, 2.4):
        root.add("trim", box(0.12, 2.3, 0.12).move(x, _PLINTH + 1.15, front + 1.35))

    port_x, port_w, port_d = length / 2, 3.4, 5.8
    top, rest = slab(
        [
            (port_x, 2.75, -port_d / 2),
            (port_x, 2.75, port_d / 2),
            (port_x + port_w, 2.6, port_d / 2),
            (port_x + port_w, 2.6, -port_d / 2),
        ],
        0.14,
    )
    root.add("roof", top.shade(0.85))
    root.add("trim", rest)
    for z in (-port_d / 2 + 0.2, port_d / 2 - 0.2):
        root.add("trim", box(0.14, 2.5, 0.14).move(port_x + port_w - 0.2, 1.25, z))
    root.add("foundation", box(port_w, 0.1, port_d).move(port_x + port_w / 2, 0.05, 0))
    return Model(
        root,
        _palette(0x9DB6A8, 0x66737A, 0xF3EFE4),
        {
            "lengthM": length,
            "widthM": width,
            "eaveHeightM": round(eave, 2),
            "ridgeHeightM": round(ridge, 2),
        },
    )


def shop() -> Model:
    """Two-storey Front Street shop: false front, balcony over the pavement, flat roof behind."""
    size = (12.0, 9.0)
    length, width = size
    storey, height = 3.1, 6.4
    root = Node("shop")
    root.add("foundation", box(length + 0.12, 0.2, width + 0.12).move(y=0.1))
    root.add("wall", box(length, height, width).move(y=0.2 + height / 2))
    top = 0.2 + height
    front = width / 2

    root.add("roof", box(length - 0.5, 0.06, width - 0.5).move(y=top + 0.03))
    for z in (-1.0, 1.0):
        root.add("wall", box(length, 0.6, 0.25).move(0, top + 0.3, z * (front - 0.125)))
        root.add("wall", box(0.25, 0.6, width - 0.5).move(z * (length / 2 - 0.125), top + 0.3, 0))
    root.add("wall", box(length, 0.7, 0.25).move(0, top + 0.95, front - 0.125))
    root.add("wall", box(5.2, 0.6, 0.25).move(0, top + 1.6, front - 0.125))
    root.add("trim", box(length + 0.2, 0.1, 0.4).move(0, top + 1.3, front - 0.125))
    root.add("trim", box(5.4, 0.1, 0.4).move(0, top + 1.95, front - 0.125))
    root.add("door", box(4.2, 0.75, 0.08).move(0, top + 1.1, front + 0.03))

    _fit(root, _door(1.8, 2.3), "front", 0.0, 0.2 + 1.15, size)
    for x in (-3.7, 3.7):
        _fit(root, _window(3.4, 2.0), "front", x, 0.2 + 1.45, size)
    for x in (-4.0, 0.0, 4.0):
        _fit(root, _door(1.2, 2.0), "front", x, 0.2 + storey + 1.1, size)
    for side in ("left", "right"):
        for z in (-2.4, 2.4):
            for floor in (0, 1):
                _fit(root, _window(1.3, 1.5), side, z, 0.2 + floor * storey + 1.6, size)
    _fit(root, _door(1.0, 2.1), "back", 3.0, 0.2 + 1.05, size)
    for x in (-3.0, 0.5):
        _fit(root, _window(1.3, 1.5), "back", x, 0.2 + storey + 1.6, size)

    deep = 2.3
    deck = 0.2 + storey
    root.add("wood", box(length, 0.16, deep).move(0, deck - 0.08, front + deep / 2))
    posts = [-length / 2 + 0.15 + k * (length - 0.3) / 4 for k in range(5)]
    for x in posts:
        root.add(
            "trim", box(0.16, deck + 2.25, 0.16).move(x, (deck + 2.25) / 2, front + deep - 0.12)
        )
    for y in (deck + 0.95, deck + 0.5):
        root.add("trim", box(length, 0.07, 0.07).move(0, y, front + deep - 0.12))
    for x in (-length / 2 + 0.05, length / 2 - 0.05):
        root.add("trim", box(0.07, 0.07, deep).move(x, deck + 0.95, front + deep / 2))
    awning, rest = slab(
        [
            (-length / 2 - 0.15, deck + 2.8, front),
            (length / 2 + 0.15, deck + 2.8, front),
            (length / 2 + 0.15, deck + 2.3, front + deep + 0.3),
            (-length / 2 - 0.15, deck + 2.3, front + deep + 0.3),
        ],
        0.1,
    )
    root.add("roof", awning.shade(0.9))
    root.add("trim", rest)

    for x, z in ((-3.2, -1.5), (2.4, -2.2)):
        root.add("metal", box(1.5, 0.8, 1.1, bevel=0.08).move(x, top + 0.5, z).under(0.75))
        root.add("door", cap(ring(8, 0.36, 0.0), up=True).move(x, top + 0.91, z))
    root.add("metal", cylinder(6, 0.12, 0.9).move(3.8, top + 0.06, 1.2))
    return Model(
        root,
        _palette(0xDCC79C, 0x7C4739, 0x3F5E4E),
        {"lengthM": length, "widthM": width, "heightM": round(top, 2)},
    )


def ruin() -> Model:
    """What the fire leaves of a house: scorched slab, wall stubs, fallen beams, roof sheets."""
    rng = random.Random(7)
    size = (11.0, 7.6)
    length, width = size
    materials = {
        "ash": Material(0x7C7770, roughness=1.0),
        "char": Material(0x2B2724, roughness=1.0),
        "rust": Material(0x6E4B3A, roughness=0.9),
    }
    root = Node("ruin")
    root.add("ash", box(length, 0.25, width).move(y=0.125).speckle(rng, 0.25))

    def stub(x: float, z: float, run: float, turn: float) -> Mesh:
        """A length of burnt wall with a broken top edge."""
        h0, h1 = rng.uniform(0.3, 1.5), rng.uniform(0.2, 1.1)
        top = rect(run, 0.16, 0.0)
        top[:, 1] = [h1, h0, h0 * rng.uniform(0.8, 1.0), h1 * rng.uniform(0.8, 1.0)]
        piece = loft([rect(run, 0.16), top], top=True)
        return piece.move(y=0.25).turn("y", turn).move(x=x, z=z)

    hx, hz = length / 2 - 0.08, width / 2 - 0.08
    for x in (-4.2, -1.6, 1.3, 4.1):
        for z in (-hz, hz):
            if rng.random() < 0.8:
                root.add("char", stub(x + rng.uniform(-0.3, 0.3), z, rng.uniform(1.4, 2.4), 0))
    for z in (-2.2, 0.4, 2.4):
        for x in (-hx, hx):
            if rng.random() < 0.8:
                root.add("char", stub(x, z + rng.uniform(-0.3, 0.3), rng.uniform(1.3, 2.0), 90))
    for x, z in ((-hx, -hz), (hx, hz), (1.0, -0.6)):
        root.add("char", box(0.18, 2.3, 0.18).turn("z", rng.uniform(-6, 6)).move(x, 1.3, z))

    for _ in range(7):
        beam = box(rng.uniform(2.2, 4.2), 0.16, 0.2).turn("z", rng.uniform(-4, 14))
        at = (rng.uniform(-3.4, 3.4), rng.uniform(0.4, 0.75), rng.uniform(-2.4, 2.4))
        root.add("char", beam.turn("y", rng.uniform(0, 180)).move(*at))
    for _ in range(4):
        sheet = box(rng.uniform(1.6, 2.4), 0.04, rng.uniform(0.9, 1.3)).turn(
            "x", rng.uniform(-18, 18)
        )
        at = (rng.uniform(-3.6, 3.6), rng.uniform(0.42, 0.7), rng.uniform(-2.4, 2.4))
        root.add("rust", sheet.turn("y", rng.uniform(0, 180)).move(*at).speckle(rng, 0.3))
    for _ in range(9):
        lump = blob(rng, 0, 0.3).scale(
            rng.uniform(0.3, 0.7), rng.uniform(0.15, 0.32), rng.uniform(0.3, 0.6)
        )
        at = (rng.uniform(-4.6, 4.6), 0.33, rng.uniform(-3.1, 3.1))
        root.add("ash" if rng.random() < 0.5 else "char", lump.move(*at).speckle(rng, 0.2))
    root.add("rust", cylinder(8, 0.3, 1.45).turn("z", 7).move(3.4, 0.25, -2.3).graded(0.7, 1.0))
    root.add("rust", box(0.8, 0.9, 0.7).turn("y", 20).move(-3.3, 0.7, 1.9).shade(0.75))
    root.parts["char"] = root.parts["char"].speckle(rng, 0.3)
    return Model(root, materials, {"lengthM": length, "widthM": width})
