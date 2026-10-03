import json
import struct
from typing import Any

import numpy as np
import pytest
from ember_asset_builder.gltf import Material, Model, Node, encode
from ember_asset_builder.mesh import box


def parse(glb: bytes) -> tuple[dict[str, Any], bytes]:
    magic, version, length = struct.unpack_from("<4sII", glb)
    assert (magic, version, length) == (b"glTF", 2, len(glb))
    json_len, json_tag = struct.unpack_from("<I4s", glb, 12)
    assert json_tag == b"JSON" and json_len % 4 == 0
    doc = json.loads(glb[20 : 20 + json_len])
    bin_len, bin_tag = struct.unpack_from("<I4s", glb, 20 + json_len)
    assert bin_tag == b"BIN\0"
    return doc, glb[28 + json_len : 28 + json_len + bin_len]


def sample() -> Model:
    root = Node("thing")
    root.add("body", box(2, 2, 2).shade(0.5))
    arm = Node("arm", at=(0.0, 3.0, 0.0))
    arm.add("glow", box(1, 1, 1))
    root.children.append(arm)
    materials = {
        "body": Material(0xFF0000),
        "glow": Material(0xFFFFFF, unlit=True, alpha=0.5, double_sided=True),
    }
    return Model(root, materials, {"heightM": 3.5})


def test_glb_holds_every_triangle_with_normals_and_tints() -> None:
    doc, binary = parse(encode(sample()))
    assert doc["buffers"] == [{"byteLength": len(binary)}]
    for mesh in doc["meshes"]:
        attributes = mesh["primitives"][0]["attributes"]
        assert set(attributes) == {"POSITION", "NORMAL", "COLOR_0"}
        assert {doc["accessors"][i]["count"] for i in attributes.values()} == {36}
    body = doc["meshes"][0]["primitives"][0]["attributes"]
    position = doc["accessors"][body["POSITION"]]
    assert (position["min"], position["max"]) == ([-1, -1, -1], [1, 1, 1])
    view = doc["bufferViews"][doc["accessors"][body["COLOR_0"]]["bufferView"]]
    tint = np.frombuffer(binary, "<f4", 3, view["byteOffset"])
    assert tint == pytest.approx([0.5, 0.5, 0.5])


def test_nodes_keep_names_offsets_and_extras() -> None:
    doc, _ = parse(encode(sample()))
    root, arm = doc["nodes"]
    assert (root["name"], root["children"], root["extras"]) == ("thing", [1], {"heightM": 3.5})
    assert (arm["name"], arm["translation"]) == ("arm", [0.0, 3.0, 0.0])


def test_materials_carry_colour_and_render_flags() -> None:
    doc, _ = parse(encode(sample()))
    body, glow = doc["materials"]
    assert body["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 1.0]
    assert "alphaMode" not in body
    assert (glow["alphaMode"], glow["doubleSided"]) == ("BLEND", True)
    assert doc["extensionsUsed"] == ["KHR_materials_unlit"]


def test_model_reports_size_in_its_own_coordinates() -> None:
    low, high = sample().bounds()
    assert (low[1], high[1]) == (-1.0, 3.5)
    assert sample().triangles() == 24
