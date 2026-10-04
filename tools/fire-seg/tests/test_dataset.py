from pathlib import Path

import pytest
import yaml
from ember_fire_seg.classes import CLASSES, FLAME
from ember_fire_seg.dataset import assemble
from ember_fire_seg.labels import Instance, box_polygon
from ember_fire_seg.sources import SourceInfo, Stager, source_dir


def stage(root: Path, name: str, count: int, synthetic: bool = False, block: int = 1) -> None:
    stager = Stager(
        source_dir(root, name), SourceInfo(name, "test", synthetic, True, block, "CC0", "here")
    )
    for i in range(count):
        flame = [Instance(FLAME, box_polygon(0.5, 0.5, 0.2, 0.2))] if i % 2 else []
        stager.add(f"img{i}", bytes([i % 256]) * (i + 1), ".jpg", flame)
    stager.finish()


def names(out: Path, split: str) -> list[str]:
    folder = out / "images" / split
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


def test_assembles_splits_with_the_test_set_from_named_sources(tmp_path: Path) -> None:
    stage(tmp_path, "flame", 200, block=10)
    stage(tmp_path, "roboflow", 100)
    out = tmp_path / "dataset"
    manifest = assemble(tmp_path, out, test_sources=["flame"], test_frac=0.25, val_frac=0.1)
    test = names(out, "test")
    assert test and all(n.startswith("flame__") for n in test)
    assert 20 <= len(test) <= 90
    # Video blocks of 10 frames never straddle splits.
    for split in ("train", "val", "test"):
        blocks = {int(n.split("__")[1][:6]) // 10 for n in names(out, split) if "flame" in n}
        for other in {"train", "val", "test"} - {split}:
            theirs = {int(n.split("__")[1][:6]) // 10 for n in names(out, other) if "flame" in n}
            assert not blocks & theirs
    assert sum(sum(c.values()) for c in manifest["images"].values()) == 300
    assert manifest["instances"]["train"]["flame"] > 0
    data = yaml.safe_load((out / "data.yaml").read_text())
    assert data["names"] == dict(enumerate(CLASSES)) and data["test"] == "images/test"
    assert len(list((out / "labels" / "train").iterdir())) == len(names(out, "train"))


def test_version_is_stable_and_follows_content(tmp_path: Path) -> None:
    stage(tmp_path, "a", 30)
    first = assemble(tmp_path, tmp_path / "d1")["version"]
    assert assemble(tmp_path, tmp_path / "d2")["version"] == first
    assert assemble(tmp_path, tmp_path / "d3", seed=1)["version"] != first


def test_synthetic_images_are_capped(tmp_path: Path) -> None:
    stage(tmp_path, "real", 70)
    stage(tmp_path, "demo", 200, synthetic=True)
    manifest = assemble(tmp_path, tmp_path / "out", synthetic_cap=0.3, val_frac=0.0)
    train = manifest["images"]["train"]
    share = train["demo"] / (train["demo"] + train["real"])
    assert 0.2 < share <= 0.3
    with pytest.raises(ValueError, match="synthetic-cap"):
        assemble(tmp_path, tmp_path / "x", sources=["demo"])
    assert assemble(tmp_path, tmp_path / "y", sources=["demo"], synthetic_cap=1)["images"]


def test_unknown_sources_are_named(tmp_path: Path) -> None:
    stage(tmp_path, "a", 3)
    with pytest.raises(FileNotFoundError, match="nope"):
        assemble(tmp_path, tmp_path / "o", sources=["a", "nope"])
    with pytest.raises(ValueError, match="b"):
        assemble(tmp_path, tmp_path / "o", test_sources=["b"])
