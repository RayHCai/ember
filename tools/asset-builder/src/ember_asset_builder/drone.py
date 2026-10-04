"""The survey quadcopter: a two-tone hull on folding arms, with skids, antennas, navigation
lights and a camera payload (wide, zoom and thermal) on a pitching gimbal."""

from __future__ import annotations

import random

import numpy as np

from .gltf import Material, Model, Node
from .mesh import Array, Mesh, blob, box, cap, lathe, loft, ring, rotation, skin, strut, tube

MATERIALS = {
    "shell": Material(0xECEEF0, roughness=0.5),
    "chassis": Material(0x30353B, roughness=0.6),
    "carbon": Material(0x1B1D20, roughness=0.7),
    "housing": Material(0x535A62, roughness=0.6),
    "motor": Material(0x99A1A8, roughness=0.4),
    "accent": Material(0xFF5A1F, roughness=0.6),
    "glass": Material(0x0D2233, roughness=0.12),
    "thermal": Material(0x8A5A1E, roughness=0.15),
    "rubber": Material(0x131415, roughness=0.95),
    "led_front": Material(0xFF4A1F, emissive=0xFF4A1F),
    "led_rear": Material(0x3DFF7A, emissive=0x3DFF7A),
    "strobe": Material(0xFFFFFF, emissive=0xFFFFFF),
    "rotor_blur": Material(0xAEB6BE, alpha=0.16, double_sided=True),
}

PROP_RADIUS_M = 0.2
# Hull stations from tail to nose: z, half-width, height above and below the waist, lift.
_HULL = np.array(
    [
        (-0.215, 0.036, 0.020, 0.018, 0.014),
        (-0.180, 0.078, 0.046, 0.036, 0.006),
        (-0.060, 0.100, 0.060, 0.050, 0.000),
        (0.070, 0.100, 0.058, 0.052, 0.000),
        (0.105, 0.094, 0.054, 0.052, -0.002),
        (0.135, 0.088, 0.050, 0.050, -0.003),
        (0.190, 0.064, 0.036, 0.042, -0.008),
        (0.232, 0.034, 0.016, 0.026, -0.014),
    ]
)
# Bands of the upper shell (between stations) painted in the accent colour.
_STRIPE = (4,)
# Motor centres: (x, y, z, propeller turns clockwise seen from above).
_MOTORS = {
    "front_left": (0.27, 0.035, 0.25, True),
    "front_right": (-0.27, 0.035, 0.25, False),
    "rear_left": (0.27, 0.035, -0.27, False),
    "rear_right": (-0.27, 0.035, -0.27, True),
}


def _along_z(mesh: Mesh) -> Mesh:
    """Lay a mesh built up the Y axis down along +Z."""
    return mesh.turn("x", 90)


def _section(station: Array) -> tuple[Array, Array]:
    """Lower and upper half of the hull's cross-section, each running waist to waist."""
    z, w, top, bottom, lift = station
    lower = [
        (w, 0.0),
        (w * 0.9, -bottom * 0.6),
        (w * 0.5, -bottom),
        (-w * 0.5, -bottom),
        (-w * 0.9, -bottom * 0.6),
        (-w, 0.0),
    ]
    upper = [
        (-w, 0.0),
        (-w * 0.92, top * 0.55),
        (-w * 0.55, top),
        (w * 0.55, top),
        (w * 0.92, top * 0.55),
        (w, 0.0),
    ]

    def laid(outline: list[tuple[float, float]]) -> Array:
        return np.array([[x, z, -(y + lift)] for x, y in outline])

    return laid(lower), laid(upper)


def _hull(root: Node) -> None:
    sections = [_section(s) for s in _HULL]
    root.add("chassis", _along_z(skin([lower for lower, _ in sections])).under(0.75))
    for k in range(len(sections) - 1):
        band = _along_z(skin([sections[k][1], sections[k + 1][1]]))
        root.add("accent" if k in _STRIPE else "shell", band.under(0.8))
    tail = np.concatenate([sections[0][0], sections[0][1][1:-1]])
    nose = np.concatenate([sections[-1][0], sections[-1][1][1:-1]])
    root.add("chassis", _along_z(cap(tail, up=False)))
    root.add("glass", _along_z(cap(nose, up=True)))

    root.add("chassis", box(0.112, 0.034, 0.2, bevel=0.009).move(0, 0.071, -0.055).under(0.8))
    for z in (-0.12, -0.075, -0.03):
        root.add("carbon", box(0.09, 0.006, 0.012).move(0, 0.09, z))
    root.add("accent", box(0.05, 0.008, 0.022).move(0, 0.09, 0.022))
    for k in range(4):
        root.add("led_rear", box(0.009, 0.006, 0.004).move(-0.027 + 0.018 * k, 0.074, -0.156))
    root.add(
        "shell", lathe([(0.03, 0.058), (0.03, 0.07), (0.022, 0.08), (0.0, 0.082)], 10).move(z=0.075)
    )
    root.add("strobe", lathe([(0.011, 0.088), (0.009, 0.098), (0.0, 0.102)], 6).move(z=-0.115))
    # Forward obstacle sensors behind a dark visor.
    root.add("glass", box(0.09, 0.02, 0.014, bevel=0.004).move(0, -0.004, 0.216))
    for s in (-1, 1):
        eye = _along_z(lathe([(0.008, 0.0), (0.008, 0.006), (0.005, 0.008), (0.0, 0.008)], 6))
        root.add("housing", eye.move(s * 0.028, -0.004, 0.222))
        root.add("led_front", box(0.02, 0.006, 0.008).move(s * 0.05, 0.012, 0.196))
    root.add("led_rear", box(0.06, 0.008, 0.006).move(0, 0.012, -0.214))
    for s in (-1, 1):
        root.add("carbon", box(0.004, 0.02, 0.07).move(s * 0.099, 0.012, -0.02))


def _blade(clockwise: bool) -> tuple[Mesh, Mesh]:
    """One propeller blade reaching along +X, as (blade, coloured tip)."""
    stations = [0.012, 0.05, 0.12, 0.18, PROP_RADIUS_M]
    chord = [0.016, 0.04, 0.034, 0.023, 0.008]
    thick = [0.006, 0.005, 0.004, 0.003, 0.002]
    pitch = [30.0, 24.0, 14.0, 9.0, 8.0]
    sweep = [0.0, 0.004, 0.002, -0.004, -0.010]
    rings = []
    for r, c, t, p, s in zip(stations, chord, thick, pitch, sweep, strict=True):
        section = ring(4, t / 2, 0.0, c / 2) @ rotation("y", p).T
        rings.append(section + np.array([0.0, r, s]))
    blade, tip = (
        part.turn("z", -90) for part in (loft(rings[:4], bottom=True), loft(rings[3:], top=True))
    )
    # As lofted, the raised leading edge suits a counter-clockwise turn (seen from above).
    if clockwise:
        blade, tip = blade.scale(1, 1, -1), tip.scale(1, 1, -1)
    return blade, tip


def _propeller(name: str, at: tuple[float, float, float], clockwise: bool, angle: float) -> Node:
    node = Node(f"propeller_{name}", at=at)
    blade, tip = _blade(clockwise)
    for half_turn in (0.0, 180.0):
        node.add("carbon", blade.turn("y", angle + half_turn))
        node.add("accent", tip.turn("y", angle + half_turn))
    node.add("motor", lathe([(0.013, -0.008), (0.013, 0.004), (0.007, 0.011), (0.0, 0.012)], 8))
    return node


def _arm(root: Node, name: str, x: float, y: float, z: float, clockwise: bool, index: int) -> None:
    side, fore = (1 if x > 0 else -1), (1 if z > 0 else -1)
    shoulder = (side * 0.088, 0.008, 0.1 if fore > 0 else -0.125)
    elbow = (side * 0.15, 0.02, shoulder[2] + fore * 0.055)
    root.add("carbon", tube([shoulder, elbow, (x, y - 0.012, z)], [0.02, 0.017, 0.013], 6))
    root.add(
        "chassis",
        lathe([(0.0, -0.024), (0.027, -0.02), (0.027, 0.02), (0.0, 0.024)], 8).move(*shoulder),
    )
    root.add("accent", lathe([(0.0285, -0.004), (0.0285, 0.004)], 8).move(*shoulder))
    mount = [(0.0, -0.036), (0.022, -0.034), (0.031, -0.024), (0.031, 0.0), (0.026, 0.004)]
    bell = [(0.026, 0.004), (0.029, 0.009), (0.029, 0.03), (0.023, 0.038), (0.0, 0.039)]
    root.add("carbon", lathe(mount, 10).move(x, y, z))
    root.add("motor", lathe(bell, 10).move(x, y, z).under(0.8))
    root.add("accent", lathe([(0.0298, 0.013), (0.0298, 0.018)], 10).move(x, y, z))
    root.add(
        "led_front" if fore > 0 else "led_rear",
        lathe([(0.016, -0.04), (0.0, -0.043)], 8).flipped().move(x, y, z),
    )
    root.add(
        "led_front" if fore > 0 else "led_rear",
        lathe([(0.016, -0.036), (0.016, -0.04)], 8).move(x, y, z),
    )
    root.children.append(_propeller(name, (x, y + 0.048, z), clockwise, 25.0 + 47.0 * index))
    blur = Node(f"rotor_blur_{name}", at=(x, y + 0.05, z))
    blur.add("rotor_blur", cap(ring(24, PROP_RADIUS_M), up=True))
    root.children.append(blur)


def _gear(root: Node) -> None:
    for side in (-1, 1):
        x = side * 0.165
        rail = [(x, -0.172, -0.165), (x, -0.172, 0.14), (x, -0.15, 0.178)]
        root.add("carbon", tube(rail, 0.009, 6, bottom=True, top=True))
        for a, b in (
            ((x, -0.172, -0.168), (x, -0.172, -0.12)),
            ((x, -0.172, 0.07), (x, -0.172, 0.125)),
        ):
            root.add("rubber", tube([a, b], 0.013, 6, bottom=True, top=True))
        for z_top, z_foot in ((0.085, 0.1), (-0.095, -0.115)):
            leg = [
                (side * 0.07, -0.04, z_top),
                (side * 0.12, -0.11, (z_top + z_foot) / 2),
                (x, -0.172, z_foot),
            ]
            root.add("carbon", tube(leg, [0.011, 0.009, 0.008], 5))
        paddle = strut((side * 0.05, 0.0, -0.2), (side * 0.075, -0.105, -0.24), 0.014, 0.004)
        root.add("carbon", paddle)
    root.add("carbon", strut((-0.165, -0.172, -0.115), (0.165, -0.172, -0.115), 0.008))


def _gimbal(root: Node) -> None:
    """Camera on its pitch axis: the node's origin is the pivot, the lenses look along +Z."""
    pivot = (0.0, -0.122, 0.14)
    root.add("carbon", box(0.07, 0.008, 0.07, bevel=0.002).move(0, -0.058, 0.14))
    for sx in (-1, 1):
        for sz in (-1, 1):
            root.add(
                "rubber",
                blob(random.Random(0), 0, 0.0)
                .scale(0.008)
                .move(sx * 0.026, -0.066, 0.14 + sz * 0.026),
            )
    root.add(
        "chassis",
        lathe([(0.0, -0.096), (0.022, -0.094), (0.022, -0.072), (0.0, -0.07)], 8).move(z=0.14),
    )
    root.add("carbon", box(0.118, 0.01, 0.022).move(0, -0.094, 0.14))
    for side in (-1, 1):
        root.add("carbon", box(0.008, 0.04, 0.022).move(side * 0.055, -0.112, 0.14))
        hub = lathe([(0.0, 0.0), (0.014, 0.001), (0.014, 0.01), (0.0, 0.011)], 8)
        root.add("housing", hub.turn("z", -90 * side).move(side * 0.055, pivot[1], pivot[2]))

    node = Node("gimbal", at=pivot)
    node.add("housing", box(0.09, 0.06, 0.07, bevel=0.01).under(0.7))
    for k in range(3):
        node.add("carbon", box(0.07, 0.04, 0.004).move(0, 0.0, -0.039 - 0.007 * k))
    lenses = (
        ("glass", -0.022, 0.004, 0.019),
        ("glass", 0.016, 0.012, 0.012),
        ("thermal", 0.018, -0.014, 0.01),
    )
    for material, x, y, radius in lenses:
        barrel = lathe([(radius + 0.004, 0.0), (radius + 0.004, 0.012), (radius, 0.014)], 10)
        node.add("carbon", _along_z(barrel).move(x, y, 0.035))
        node.add(material, _along_z(cap(ring(10, radius, 0.012), up=True)).move(x, y, 0.035))
    node.add("accent", box(0.012, 0.007, 0.004).move(-0.022, -0.022, 0.036))
    root.children.append(node)


def quadcopter() -> Model:
    root = Node("quadcopter")
    _hull(root)
    for index, (name, (x, y, z, clockwise)) in enumerate(_MOTORS.items()):
        _arm(root, name, x, y, z, clockwise, index)
    _gear(root)
    _gimbal(root)
    span = 2 * (max(abs(m[0]) for m in _MOTORS.values()) + PROP_RADIUS_M)
    return Model(root, MATERIALS, {"spanM": round(span, 3), "propRadiusM": PROP_RADIUS_M})
