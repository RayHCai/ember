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
    assert 0 < model.triangles() < 2000


@pytest.mark.parametrize("key", CATALOG)
def test_model_builds_the_same_every_time(key: str) -> None:
    assert encode(CATALOG[key]()) == encode(CATALOG[key]())


@pytest.mark.parametrize("form", FORMS)
def test_trees_stand_on_the_ground_and_say_their_size(form: str) -> None:
    for variant in "ab":
        full = CATALOG[f"trees/{form}_{variant}"]()
        far = CATALOG[f"trees/{form}_{variant}_lod1"]()
        low, high = full.bounds()
        assert low[1] == pytest.approx(0, abs=0.1)
        assert full.extras["heightM"] == pytest.approx(high[1], abs=0.01)
        assert "foliage" in full.root.parts
        assert far.triangles() < full.triangles() / 2
        assert far.extras["heightM"] == pytest.approx(full.extras["heightM"], rel=0.05)


def test_quadcopter_has_the_parts_a_consumer_moves() -> None:
    names = CATALOG["drone/quadcopter"]().node_names()
    assert "gimbal" in names
    for motor in ("front_left", "front_right", "rear_left", "rear_right"):
        assert f"propeller_{motor}" in names and f"rotor_blur_{motor}" in names


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
