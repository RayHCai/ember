"""The survey quadcopter: hull, arms, motors, propellers, skids and a pitching camera gimbal."""

from __future__ import annotations

import numpy as np

from .gltf import Material, Model, Node
from .mesh import Array, Mesh, box, cap, cylinder, loft, ring, rotation, tube

MATERIALS = {
    "shell": Material(0xE6E9EC, roughness=0.55),
    "carbon": Material(0x24272B, roughness=0.7),
    "housing": Material(0x4A5057, roughness=0.6),
    "motor": Material(0x9AA2A9, roughness=0.4),
    "accent": Material(0xFF5A1F, roughness=0.6),
    "glass": Material(0x0E2538, roughness=0.15),
    "led_front": Material(0xFF4A1F, emissive=0xFF4A1F),
    "led_rear": Material(0x3DFF7A, emissive=0x3DFF7A),
    "rotor_blur": Material(0xAEB6BE, alpha=0.16, double_sided=True),
}

PROP_RADIUS_M = 0.192
# Hull stations along Z: half-width, height above and below the centreline, and its lift.
_HULL_Z = [-0.22, -0.18, -0.04, 0.09, 0.18, 0.235]
_HULL_W = [0.040, 0.082, 0.100, 0.098, 0.074, 0.040]
_HULL_TOP = [0.022, 0.048, 0.058, 0.056, 0.044, 0.020]
_HULL_BOTTOM = [0.020, 0.040, 0.052, 0.052, 0.048, 0.032]
_HULL_LIFT = [0.012, 0.004, 0.0, 0.0, -0.004, -0.012]
# Motor centres: (x, y, z, propeller turns clockwise seen from above).
_MOTORS = {
    "front_left": (0.25, 0.03, 0.23, True),
    "front_right": (-0.25, 0.03, 0.23, False),
    "rear_left": (0.25, 0.03, -0.25, False),
    "rear_right": (-0.25, 0.03, -0.25, True),
}


def _hull_section(z: float, grow: float = 1.0) -> Array:
    """Eight-sided cross-section at `z`, listed for a loft that is then laid down along +Z."""
    w = grow * float(np.interp(z, _HULL_Z, _HULL_W))
    top = grow * float(np.interp(z, _HULL_Z, _HULL_TOP))
    bottom = grow * float(np.interp(z, _HULL_Z, _HULL_BOTTOM))
    lift = float(np.interp(z, _HULL_Z, _HULL_LIFT))
    outline = [
        (w, top * 0.45),
        (w, -bottom * 0.4),
        (w * 0.6, -bottom),
        (-w * 0.6, -bottom),
        (-w, -bottom * 0.4),
        (-w, top * 0.45),
        (-w * 0.55, top),
        (w * 0.55, top),
    ]
    return np.array([[x, z, -(y + lift)] for x, y in outline])


def _along_z(mesh: Mesh) -> Mesh:
    """Lay a mesh built up the Y axis down along +Z."""
    return mesh.turn("x", 90)


def _blade(clockwise: bool) -> tuple[Mesh, Mesh]:
    """One propeller blade reaching along +X, as (blade, coloured tip)."""
    stations = [0.012, 0.05, 0.12, 0.175, PROP_RADIUS_M]
    chord = [0.016, 0.038, 0.032, 0.022, 0.008]
    thick = [0.006, 0.005, 0.004, 0.003, 0.002]
    pitch = [30.0, 24.0, 14.0, 9.0, 8.0]
    sweep = [0.0, 0.004, 0.002, -0.004, -0.010]
    rings = []
    for r, c, t, p, s in zip(stations, chord, thick, pitch, sweep, strict=True):
        section = ring(4, t / 2, 0.0, c / 2) @ rotation("y", p).T
        rings.append(section + np.array([0.0, r, s]))
    parts = [loft(rings[:4], bottom=True), loft(rings[3:], top=True)]
    blade, tip = (part.turn("z", -90) for part in parts)
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
    node.add("motor", cylinder(8, 0.012, 0.016, r_top=0.007).move(y=-0.008))
    return node


def _gimbal() -> Node:
    """Camera on its pitch axis: the node's origin is the pivot, the lenses look along +Z."""
    node = Node("gimbal", at=(0.0, -0.118, 0.145))
    node.add("carbon", box(0.098, 0.012, 0.022).move(y=0.03))
    for side in (-1, 1):
        node.add("carbon", box(0.008, 0.046, 0.022).move(x=side * 0.045, y=0.008))
    node.add("housing", box(0.074, 0.054, 0.076, bevel=0.008).under(0.7))
    for x, y, radius in ((-0.015, 0.0, 0.017), (0.019, 0.006, 0.011)):
        barrel = loft([ring(8, radius), ring(8, radius, 0.014)])
        node.add("carbon", _along_z(barrel).move(x, y, 0.038))
        node.add("glass", _along_z(cap(ring(8, radius * 0.86, 0.012), up=True)).move(x, y, 0.038))
    node.add("accent", box(0.012, 0.008, 0.004).move(0.019, -0.014, 0.039))
    return node


def quadcopter() -> Model:
    root = Node("quadcopter")
    hull = _along_z(loft([_hull_section(z) for z in _HULL_Z], bottom=True, top=True))
    root.add("shell", hull.under(0.72))
    band = loft([_hull_section(z, grow=1.035) for z in (0.098, 0.128)], bottom=True, top=True)
    root.add("accent", _along_z(band))
    root.add("carbon", box(0.104, 0.03, 0.2, bevel=0.008).move(0, 0.066, -0.04))
    root.add("accent", box(0.05, 0.006, 0.02).move(0, 0.082, -0.125))
    root.add("shell", cylinder(8, 0.024, 0.012, r_top=0.019).move(0, 0.081, 0.015))
    root.add("glass", box(0.072, 0.014, 0.01, bevel=0.003).move(0, -0.012, 0.236))
    root.add("led_rear", box(0.014, 0.008, 0.014).move(0, 0.085, -0.09))

    for name, (x, y, z, clockwise) in _MOTORS.items():
        side, fore = (1 if x > 0 else -1), (1 if z > 0 else -1)
        shoulder = (side * 0.08, 0.012, 0.09 if fore > 0 else -0.11)
        root.add("carbon", tube([shoulder, (x, y, z)], [0.018, 0.013], 6))
        root.add("shell", box(0.05, 0.034, 0.05, bevel=0.008).move(*shoulder).under(0.72))
        root.add("carbon", cylinder(8, 0.028, 0.046).move(x, y - 0.012, z))
        root.add("motor", cylinder(8, 0.024, 0.018, r_top=0.02).move(x, y + 0.034, z))
        root.add(
            "led_front" if fore > 0 else "led_rear", box(0.03, 0.01, 0.03).move(x, y - 0.017, z)
        )
        angle = 25.0 + 47.0 * list(_MOTORS).index(name)
        root.children.append(_propeller(name, (x, y + 0.06, z), clockwise, angle))
        blur = Node(f"rotor_blur_{name}", at=(x, y + 0.061, z))
        blur.add("rotor_blur", cap(ring(20, PROP_RADIUS_M), up=True))
        root.children.append(blur)

    for side in (-1, 1):
        rail = [
            (side * 0.15, -0.165, -0.15),
            (side * 0.15, -0.165, 0.13),
            (side * 0.15, -0.143, 0.172),
        ]
        root.add("carbon", tube(rail, 0.008, 5, bottom=True, top=True))
        for z_top, z_foot in ((0.09, 0.1), (-0.09, -0.11)):
            strut = [(side * 0.066, -0.036, z_top), (side * 0.15, -0.165, z_foot)]
            root.add("carbon", tube(strut, [0.009, 0.007], 5))
        whip = [(side * 0.045, -0.02, -0.195), (side * 0.062, -0.13, -0.222)]
        root.add("carbon", tube(whip, 0.004, 4, top=True))

    root.add("carbon", box(0.06, 0.012, 0.06, bevel=0.004).move(0, -0.057, 0.145))
    root.add("carbon", cylinder(8, 0.02, 0.026).move(0, -0.088, 0.145))
    root.children.append(_gimbal())

    span = 2 * (max(abs(m[0]) for m in _MOTORS.values()) + PROP_RADIUS_M)
    return Model(root, MATERIALS, {"spanM": round(span, 3), "propRadiusM": PROP_RADIUS_M})
