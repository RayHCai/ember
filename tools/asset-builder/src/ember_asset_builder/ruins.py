"""What the fire leaves of a building: scorched slab, wall stubs, fallen beams, roof sheets."""

from __future__ import annotations

import random

from . import parts
from .gltf import Material, Model, Node
from .mesh import Mesh, blob, box, cylinder, loft, rect

MATERIALS = {
    "ash": Material(0x8A857D, roughness=1.0),
    "char": Material(0x2B2724, roughness=1.0),
    "rust": Material(0x7A4E38, roughness=0.9),
}


def _stub(rng: random.Random, run: float, tallest: float) -> Mesh:
    """A length of burnt wall along X with a broken top edge, standing on y = 0."""
    h0, h1 = rng.uniform(0.3, tallest), rng.uniform(0.2, tallest * 0.7)
    top = rect(run, 0.18, 0.0)
    top[:, 1] = [h1, h0, h0 * rng.uniform(0.8, 1.0), h1 * rng.uniform(0.8, 1.0)]
    return loft([rect(run, 0.18), top], top=True)


def ruin(length: float, width: float, seed: int, lod: int = 0, *, car: bool = False) -> Model:
    rng = random.Random(seed)
    hx, hz = length / 2 - 0.1, width / 2 - 0.1
    slab = 0.22
    root = Node("ruin")
    root.add("ash", box(length, slab, width).move(y=slab / 2).speckle(rng, 0.2))
    if lod == 0:
        # Scorch marks: darker patches lying on the slab.
        for _ in range(max(3, round(length * width / 45))):
            patch = box(rng.uniform(1.5, 3.5), 0.02, rng.uniform(1.2, 3.0)).turn(
                "y", rng.uniform(0, 90)
            )
            at = (rng.uniform(-0.75, 0.75) * hx, slab + 0.01, rng.uniform(-0.75, 0.75) * hz)
            root.add("ash", patch.move(*at).shade(rng.uniform(0.45, 0.7)))

    keep = 0.45 if lod else 0.8
    for x in parts.spread(-hx, hx, 2.6 if lod == 0 else 7.0):
        for z in (-hz, hz):
            if rng.random() < keep:
                stub = _stub(rng, rng.uniform(1.3, 2.3), 1.6)
                root.add("char", stub.move(x + rng.uniform(-0.3, 0.3), slab, z))
    for z in parts.spread(-hz, hz, 2.6 if lod == 0 else 7.0):
        for x in (-hx, hx):
            if rng.random() < keep:
                stub = _stub(rng, rng.uniform(1.2, 2.0), 1.4).turn("y", 90)
                root.add("char", stub.move(x, slab, z + rng.uniform(-0.3, 0.3)))
    for x, z in ((-hx, -hz), (hx, hz), (hx * 0.2, -hz * 0.15)):
        post = box(0.2, 2.4, 0.2).turn("z", rng.uniform(-7, 7))
        root.add("char", post.move(x, slab + 1.15, z))

    area = length * width
    for _ in range(max(2, round(area / (70 if lod else 16)))):
        sheet = box(rng.uniform(1.6, 2.6), 0.05, rng.uniform(0.9, 1.4)).turn(
            "x", rng.uniform(-18, 18)
        )
        at = (
            rng.uniform(-0.8, 0.8) * hx,
            slab + rng.uniform(0.2, 0.5),
            rng.uniform(-0.8, 0.8) * hz,
        )
        root.add("rust", sheet.turn("y", rng.uniform(0, 180)).move(*at).speckle(rng, 0.3))
    if lod == 0:
        for _ in range(max(4, round(area / 18))):
            beam = box(rng.uniform(2.0, min(5.0, length * 0.5)), 0.16, 0.2).turn(
                "z", rng.uniform(-4, 14)
            )
            at = (
                rng.uniform(-0.7, 0.7) * hx,
                slab + rng.uniform(0.15, 0.5),
                rng.uniform(-0.75, 0.75) * hz,
            )
            root.add("char", beam.turn("y", rng.uniform(0, 180)).move(*at))
        for _ in range(max(6, round(area / 14))):
            lump = blob(rng, 0, 0.3).scale(
                rng.uniform(0.3, 0.8), rng.uniform(0.15, 0.35), rng.uniform(0.3, 0.7)
            )
            at = (rng.uniform(-0.9, 0.9) * hx, slab + 0.08, rng.uniform(-0.9, 0.9) * hz)
            root.add("ash" if rng.random() < 0.5 else "char", lump.move(*at).speckle(rng, 0.2))
        tank = cylinder(8, 0.3, 1.45).turn("z", 7).move(-hx * 0.6, slab, -hz * 0.7)
        root.add("rust", tank.graded(0.7, 1.0))
        root.add(
            "rust",
            box(0.8, 0.9, 0.7).turn("y", 20).move(-hx * 0.3, slab + 0.45, hz * 0.6).shade(0.75),
        )
    if car:
        husk = parts.car(rng, lod, material="rust")
        for material in ("rust", "glass", "rubber", "trim"):
            if material in husk:
                mesh = (
                    husk[material].turn("y", rng.uniform(-12, 12)).move(hx - 2.0, slab - 0.12, 0.0)
                )
                root.add("char" if material != "rust" else "rust", mesh.shade(0.8))
    root.parts["char"] = root.parts["char"].speckle(rng, 0.3)
    return Model(root, MATERIALS, {"kind": "ruin", "lengthM": length, "widthM": width})
