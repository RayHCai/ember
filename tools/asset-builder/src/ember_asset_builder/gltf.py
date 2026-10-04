"""Models as a node tree of single-material meshes, and their glTF 2.0 binary (.glb) encoding."""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .mesh import Array, Mesh, linear

GENERATOR = "ember-asset-builder"
_ARRAY_BUFFER = 34962
_FLOAT = 5126


@dataclass(frozen=True)
class Material:
    """Flat colour (sRGB hex). Vertex tints multiply it; there are no textures."""

    color: int
    roughness: float = 0.9
    emissive: int | None = None
    unlit: bool = False
    alpha: float = 1.0
    double_sided: bool = False


@dataclass
class Node:
    """A named part. Consumers move the named children (spin a propeller, pitch the gimbal)."""

    name: str
    at: tuple[float, float, float] = (0.0, 0.0, 0.0)
    parts: dict[str, Mesh] = field(default_factory=dict)
    children: list[Node] = field(default_factory=list)

    def add(self, material: str, *meshes: Mesh) -> None:
        held = [self.parts[material]] if material in self.parts else []
        self.parts[material] = Mesh.join([*held, *meshes])

    def walk(self, origin: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> list[tuple[str, Mesh]]:
        """Every (material, mesh) under this node, in the model's own coordinates."""
        here = (origin[0] + self.at[0], origin[1] + self.at[1], origin[2] + self.at[2])
        found = [(material, mesh.move(*here)) for material, mesh in self.parts.items()]
        for child in self.children:
            found += child.walk(here)
        return found


@dataclass
class Model:
    root: Node
    materials: dict[str, Material]
    extras: dict[str, float | str] = field(default_factory=dict)

    def triangles(self) -> int:
        return sum(len(mesh.tris) for _, mesh in self.root.walk())

    def bounds(self) -> tuple[Array, Array]:
        points = np.concatenate([mesh.tris.reshape(-1, 3) for _, mesh in self.root.walk()])
        return points.min(axis=0), points.max(axis=0)

    def node_names(self) -> list[str]:
        names: list[str] = []

        def visit(node: Node) -> None:
            names.append(node.name)
            for child in node.children:
                visit(child)

        visit(self.root)
        return names


def _material_json(name: str, m: Material) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": name,
        "pbrMetallicRoughness": {
            "baseColorFactor": [*(round(c, 5) for c in linear(m.color)), m.alpha],
            "metallicFactor": 0.0,
            "roughnessFactor": m.roughness,
        },
    }
    if m.emissive is not None:
        out["emissiveFactor"] = [round(c, 5) for c in linear(m.emissive)]
    if m.unlit:
        out["extensions"] = {"KHR_materials_unlit": {}}
    if m.alpha < 1.0:
        out["alphaMode"] = "BLEND"
    if m.double_sided:
        out["doubleSided"] = True
    return out


def encode(model: Model) -> bytes:
    """The model as one self-contained .glb: unindexed triangles, flat normals, COLOR_0 tints."""
    used = sorted({material for material, _ in model.root.walk()})
    doc: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": GENERATOR},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [],
        "meshes": [],
        "materials": [_material_json(name, model.materials[name]) for name in used],
        "accessors": [],
        "bufferViews": [],
    }
    if any(model.materials[name].unlit for name in used):
        doc["extensionsUsed"] = ["KHR_materials_unlit"]
    blob = bytearray()

    def accessor(data: Array, *, bounds: bool = False) -> int:
        raw = data.astype("<f4")
        doc["bufferViews"].append(
            {
                "buffer": 0,
                "byteOffset": len(blob),
                "byteLength": raw.nbytes,
                "target": _ARRAY_BUFFER,
            }
        )
        blob.extend(raw.tobytes())
        entry: dict[str, Any] = {
            "bufferView": len(doc["bufferViews"]) - 1,
            "componentType": _FLOAT,
            "count": len(raw),
            "type": "VEC3",
        }
        if bounds:
            entry["min"] = raw.min(axis=0).tolist()
            entry["max"] = raw.max(axis=0).tolist()
        doc["accessors"].append(entry)
        return len(doc["accessors"]) - 1

    def primitive(material: str, mesh: Mesh) -> dict[str, Any]:
        return {
            "attributes": {
                "POSITION": accessor(mesh.tris.reshape(-1, 3), bounds=True),
                "NORMAL": accessor(np.repeat(mesh.normals(), 3, axis=0)),
                "COLOR_0": accessor(np.repeat(np.clip(mesh.tint, 0.0, 1.0), 3, axis=0)),
            },
            "material": used.index(material),
        }

    def visit(node: Node) -> int:
        index = len(doc["nodes"])
        entry: dict[str, Any] = {"name": node.name}
        doc["nodes"].append(entry)
        if any(node.at):
            entry["translation"] = list(node.at)
        if node.parts:
            entry["mesh"] = len(doc["meshes"])
            doc["meshes"].append(
                {
                    "name": node.name,
                    "primitives": [primitive(m, node.parts[m]) for m in sorted(node.parts)],
                }
            )
        if node.children:
            entry["children"] = [visit(child) for child in node.children]
        return index

    visit(model.root)
    if model.extras:
        doc["nodes"][0]["extras"] = model.extras
    doc["buffers"] = [{"byteLength": len(blob)}]

    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    return b"".join(
        [
            struct.pack("<4sII", b"glTF", 2, total),
            struct.pack("<I4s", len(text), b"JSON"),
            text,
            struct.pack("<I4s", len(blob), b"BIN\0"),
            bytes(blob),
        ]
    )
