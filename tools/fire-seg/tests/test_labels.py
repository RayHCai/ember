from pathlib import Path

import numpy as np
import pytest
from ember_fire_seg.classes import BURNED, FLAME, SMOKE, class_for_name, class_index
from ember_fire_seg.labels import (
    Instance,
    box_polygon,
    class_mask,
    mask_instances,
    read_boxes,
    read_seg,
    write_seg,
)


@pytest.mark.parametrize(
    ("name", "cls"),
    [("fire", FLAME), ("Flame", FLAME), ("burning", FLAME), ("smoke", SMOKE),
     ("fire-smoke", SMOKE), ("burnt area", BURNED), ("burn_scar", BURNED), ("person", None)],
)  # fmt: skip
def test_other_datasets_names_map_to_our_classes(name: str, cls: int | None) -> None:
    assert class_for_name(name) == cls


def test_class_index_takes_our_names_and_theirs() -> None:
    assert class_index("burned") == BURNED and class_index("Fire") == FLAME
    with pytest.raises(ValueError):
        class_index("person")


def test_labels_round_trip_and_skip_malformed_rows(tmp_path: Path) -> None:
    path = tmp_path / "a.txt"
    tri = Instance(SMOKE, np.array([[0.1, 0.1], [0.9, 0.1], [0.5, 0.8]]))
    write_seg(path, [tri, Instance(FLAME, box_polygon(0.5, 0.5, 0.2, 0.4))])
    path.write_text(path.read_text() + "2 0.1 0.2\n")
    back = read_seg(path)
    assert [i.cls for i in back] == [SMOKE, FLAME]
    assert np.allclose(back[0].polygon, tri.polygon)
    assert np.allclose(back[1].polygon, [[0.4, 0.3], [0.6, 0.3], [0.6, 0.7], [0.4, 0.7]])
    assert read_seg(tmp_path / "missing.txt") == []


def test_boxes_read_as_normalised_rows(tmp_path: Path) -> None:
    path = tmp_path / "b.txt"
    path.write_text("1 0.5 0.5 0.2 0.2\n0 0.1 0.1 0.05 0.05 0.9\n")
    assert read_boxes(path) == [(1, 0.5, 0.5, 0.2, 0.2)]


def test_mask_instances_rasterise_back_to_the_mask() -> None:
    mask = np.zeros((60, 80), dtype=bool)
    yy, xx = np.mgrid[:60, :80]
    mask |= (xx - 25) ** 2 + (yy - 30) ** 2 <= 15**2
    mask[5:15, 60:75] = True
    mask[50, 70] = True  # speckle, dropped
    instances = mask_instances(mask, BURNED)
    assert len(instances) == 2 and all(i.cls == BURNED for i in instances)
    back = class_mask(instances, BURNED, mask.shape)
    expected = mask.copy()
    expected[50, 70] = False
    iou = (back & expected).sum() / (back | expected).sum()
    assert iou > 0.95
    assert not class_mask(instances, FLAME, mask.shape).any()
