import json
from pathlib import Path

import numpy as np
import pytest
from ember_asset_builder.catalog import CATALOG, SHEETS
from ember_asset_builder.cli import build
from ember_asset_builder.gltf import encode

FORMS = ("broadleaf", "conifer", "palm", "umbrella", "shrub")


@pytest.mark.parametrize("key", CATALOG)
def test_model_is_sound(key: str) -> None:
    model = CATALOG[key]()
    for material, mesh in model.root.walk():
        assert material in model.materials
        assert np.isfinite(mesh.tris).all() and np.isfinite(mesh.normals()).all()
        assert ((mesh.tint >= 0) & (mesh.tint <= 1)).all()
    assert 0 < model.triangles() < 4000


@pytest.mark.parametrize("key", CATALOG)
def test_model_builds_the_same_every_time(key: str) -> None:
    assert encode(CATALOG[key]()) == encode(CATALOG[key]())


@pytest.mark.parametrize("form", FORMS)
def test_trees_stand_on_the_ground_and_say_their_size(form: str) -> None:
    for variant in "ab":
        full, mid, far = (
            CATALOG[f"trees/{form}_{variant}{lod}"]() for lod in ("", "_lod1", "_lod2")
        )
        low, high = full.bounds()
        assert low[1] == pytest.approx(0, abs=0.1)
        assert full.extras["heightM"] == pytest.approx(high[1], abs=0.01)
        for model in (full, mid, far):
            assert {"bark", "foliage"} <= set(model.root.parts)
            assert model.extras["heightM"] == pytest.approx(full.extras["heightM"], rel=0.12)
        assert mid.triangles() < full.triangles() / 2
        assert far.triangles() <= 40


def test_quadcopter_has_the_parts_a_consumer_moves() -> None:
    names = CATALOG["drone/quadcopter"]().node_names()
    assert "gimbal" in names
    for motor in ("front_left", "front_right", "rear_left", "rear_right"):
        assert f"propeller_{motor}" in names and f"rotor_blur_{motor}" in names


BUILDINGS = [key for key in CATALOG if key.startswith("buildings/") and "_lod" not in key]


@pytest.mark.parametrize("key", BUILDINGS)
def test_buildings_say_their_footprint_and_have_a_far_model(key: str) -> None:
    full, far = CATALOG[key](), CATALOG[f"{key}_lod1"]()
    assert full.extras["kind"] in ("house", "block", "ruin")
    assert far.extras == full.extras
    low, high = full.bounds()
    length, width = float(full.extras["lengthM"]), float(full.extras["widthM"])
    # Walls stay on the footprint; only eaves, steps and awnings reach past it.
    assert high[0] - low[0] == pytest.approx(length, abs=2.5)
    assert high[2] - low[2] == pytest.approx(width, abs=4.5)
    # Rubble may dip into the ground; nothing else does.
    assert low[1] == pytest.approx(0, abs=0.4 if full.extras["kind"] == "ruin" else 0.01)
    assert far.triangles() < min(400, full.triangles() / 2)
    if full.extras["kind"] != "ruin":
        assert {"roof", "wall"} <= set(full.root.parts) and {"roof", "wall"} <= set(far.root.parts)
        assert 2 < float(full.extras["wallHeightM"]) < float(full.extras["heightM"])


def test_fire_and_smoke_are_unit_sized() -> None:
    low, high = CATALOG["fx/flame_a"]().bounds()
    assert (low[1], high[1]) == pytest.approx((0, 1), abs=1e-6)
    low, high = CATALOG["fx/smoke_a"]().bounds()
    assert max(abs(low).max(), abs(high).max()) <= 1 + 1e-6


def test_sheets_only_show_catalogue_models() -> None:
    for _, rows in SHEETS.values():
        assert {key for row in rows for key, _ in row} <= set(CATALOG)


def test_build_writes_models_and_manifest(tmp_path: Path) -> None:
    build(tmp_path, previews=False)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert set(manifest["assets"]) == set(CATALOG)
    for entry in manifest["assets"].values():
        assert (tmp_path / entry["file"]).read_bytes()[:4] == b"glTF"
    palm = manifest["assets"]["trees/palm_a"]
    assert palm["materials"] == ["bark", "foliage"] and palm["heightM"] > 5
    assert manifest["assets"]["buildings/house_17x12"]["kind"] == "house"
