import json
from pathlib import Path

import numpy as np
from ember_fire_seg.classes import FLAME, SMOKE
from ember_fire_seg.labels import read_seg
from ember_fire_seg.sources import (
    SourceInfo,
    label_for,
    read_info,
    stage_mask_pairs,
    stage_yolo_seg,
)
from PIL import Image


def info(name: str) -> SourceInfo:
    return SourceInfo(name, "test", False, True, 1, "CC0", "here")


def image(path: Path, size: tuple[int, int] = (40, 30)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (90, 120, 60)).save(path)


def test_label_path_swaps_the_last_images_folder() -> None:
    assert label_for(Path("/d/images/train/images/a.jpg")) == Path("/d/images/train/labels/a.txt")


def test_yolo_seg_export_is_remapped_by_class_name(tmp_path: Path) -> None:
    src = tmp_path / "roboflow"
    src.mkdir()
    (src / "data.yaml").write_text("names: ['Fire', 'person', 'smoke']\nnc: 3\n")
    for split, stem, rows in (
        ("train", "a", "0 0.1 0.1 0.5 0.1 0.3 0.5\n1 0.2 0.2 0.4 0.2 0.3 0.4\n"),
        ("valid", "b", "2 0.5 0.5 0.9 0.5 0.7 0.9\n"),
        ("test", "c", ""),
    ):
        image(src / split / "images" / f"{stem}.jpg")
        (src / split / "labels").mkdir(parents=True, exist_ok=True)
        (src / split / "labels" / f"{stem}.txt").write_text(rows)
    out = tmp_path / "staged"
    got = stage_yolo_seg(src, out, info("rf"))
    assert got.images == 3
    assert got.instances == {"flame": 1, "smoke": 1}
    assert got.notes == {"dropped_instances": 1}
    labels = sorted((out / "labels").iterdir())
    assert [[i.cls for i in read_seg(p)] for p in labels] == [[], [FLAME], [SMOKE]]
    assert read_info(out) == got
    assert json.loads((out / "source.json").read_text())["license"] == "CC0"


def test_mask_pairs_become_flame_regions(tmp_path: Path) -> None:
    image(tmp_path / "Images" / "image_1.jpg")
    image(tmp_path / "Images" / "image_2.jpg")
    mask = np.zeros((30, 40), dtype=np.uint8)
    mask[5:20, 10:30] = 255
    (tmp_path / "Masks").mkdir()
    Image.fromarray(mask).save(tmp_path / "Masks" / "image_1.png")
    got = stage_mask_pairs(
        tmp_path / "Images", tmp_path / "Masks", tmp_path / "out", info("flame"), FLAME
    )
    assert got.images == 1 and got.instances == {"flame": 1}
    assert got.notes == {"images_without_mask": 1}
    [inst] = read_seg(next((tmp_path / "out" / "labels").iterdir()))
    assert np.allclose(inst.polygon.min(axis=0), (10 / 40, 5 / 30), atol=1e-4)
    assert np.allclose(inst.polygon.max(axis=0), (30 / 40, 20 / 30), atol=1e-4)
