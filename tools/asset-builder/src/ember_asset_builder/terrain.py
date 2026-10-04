"""The ground the other models stand on."""

from __future__ import annotations

from .gltf import Material, Model, Node
from .mesh import cap, rect


def ground() -> Model:
    """A flat square one metre across, centred on the origin, for a consumer to scale and paint."""
    root = Node("ground")
    root.add("ground", cap(rect(1.0, 1.0), up=True))
    return Model(root, {"ground": Material(0xB5B0A3, roughness=1.0)}, {"sizeM": 1.0})
