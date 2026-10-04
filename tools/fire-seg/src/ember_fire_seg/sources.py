"""Stage one dataset as a source: its images and our-class segmentation labels in
`<root>/sources/<name>/{images,labels}`, plus `source.json` saying what it is.

Every converter keeps images that end up with no instances: background frames teach the model
what is not fire.
"""

from __future__ import annotations

import json
import shutil
from collections import Counter
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from PIL import Image

from .classes import CLASSES, class_for_name
from .labels import Instance, box_polygon, mask_instances, read_boxes, read_seg, write_seg

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


@dataclass
class SourceInfo:
    name: str
    kind: str
    # Rendered rather than photographed; capped in the training mix.
    synthetic: bool
    # Drone or aircraft viewpoint; only these feed the held-out test set.
    aerial: bool
    # Consecutive images (sorted by name) that must land in the same split: video frames.
    group_block: int
    license: str
    origin: str
    images: int = 0
    instances: dict[str, int] = field(default_factory=dict)
    notes: dict[str, int] = field(default_factory=dict)


def source_dir(root: Path, name: str) -> Path:
    return root / "sources" / name


def read_info(path: Path) -> SourceInfo:
    return SourceInfo(**json.loads((path / "source.json").read_text()))


def staged(root: Path) -> list[Path]:
    return sorted(p.parent for p in (root / "sources").glob("*/source.json"))


class Stager:
    """Writes a source's images and labels in order, counting instances."""

    def __init__(self, out: Path, info: SourceInfo) -> None:
        if out.exists():
            shutil.rmtree(out)
        (out / "images").mkdir(parents=True)
        (out / "labels").mkdir(parents=True)
        self.out = out
        self.info = info
        self.counts: Counter[str] = Counter()
        self.notes: Counter[str] = Counter()

    def add(self, stem: str, image: Path | bytes, suffix: str, instances: list[Instance]) -> None:
        name = f"{self.info.images:06d}_{_safe(stem)}"
        target = self.out / "images" / f"{name}{suffix.lower()}"
        if isinstance(image, bytes):
            target.write_bytes(image)
        else:
            shutil.copy2(image, target)
        write_seg(self.out / "labels" / f"{name}.txt", instances)
        self.info.images += 1
        self.counts.update(CLASSES[i.cls] for i in instances)

    def finish(self) -> SourceInfo:
        self.info.instances = dict(sorted(self.counts.items()))
        self.info.notes = dict(sorted(self.notes.items()))
        (self.out / "source.json").write_text(json.dumps(asdict(self.info), indent=2) + "\n")
        return self.info


def images_under(root: Path) -> list[Path]:
    return sorted(
        p for p in root.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES and "images" in p.parts
    )


def label_for(image: Path) -> Path:
    """The YOLO label path next to an image: the last `images` folder becomes `labels`."""
    parts = list(image.parts)
    i = len(parts) - 1 - parts[::-1].index("images")
    parts[i] = "labels"
    return Path(*parts).with_suffix(".txt")


def dataset_names(src: Path) -> list[str]:
    """Class names from a YOLO dataset's data.yaml (list or index mapping)."""
    found = sorted(src.glob("*.yaml")) + sorted(src.glob("*.yml"))
    if not found:
        raise FileNotFoundError(f"{src}: no data.yaml to read class names from; pass --names")
    data = yaml.safe_load(found[0].read_text())
    names = data.get("names") if isinstance(data, dict) else None
    if isinstance(names, dict):
        return [str(names[k]) for k in sorted(names)]
    if isinstance(names, list):
        return [str(n) for n in names]
    raise ValueError(f"{found[0]}: no names list")


def stage_yolo_seg(
    src: Path, out: Path, info: SourceInfo, names: list[str] | None = None
) -> SourceInfo:
    """A YOLO segmentation export (Roboflow 'YOLOv8/YOLO11 segmentation'), classes remapped by name;
    all its splits are pooled, since assembly re-splits."""
    mapping = _mapping(names or dataset_names(src))
    stager = Stager(out, info)
    for image in images_under(src):
        instances = []
        for inst in read_seg(label_for(image)):
            cls = mapping.get(inst.cls)
            if cls is None:
                stager.notes["dropped_instances"] += 1
                continue
            instances.append(Instance(cls, inst.polygon))
        stager.add(_stem(image, src), image, image.suffix, instances)
    return stager.finish()


def stage_mask_pairs(
    images: Path,
    masks: Path,
    out: Path,
    info: SourceInfo,
    cls: int,
    mask_suffix: str = "",
) -> SourceInfo:
    """Images with binary masks of one class (FLAME's fire segmentation set), paired by file stem;
    a mask file is the image stem plus `mask_suffix`, any image extension."""
    by_stem = {p.stem: p for p in masks.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES}
    stager = Stager(out, info)
    pictures = sorted(p for p in images.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES)
    for image in pictures:
        mask_path = by_stem.get(image.stem + mask_suffix)
        if mask_path is None:
            stager.notes["images_without_mask"] += 1
            continue
        with Image.open(mask_path) as m:
            mask = np.asarray(m.convert("L")) > 127
        stager.add(_stem(image, images), image, image.suffix, mask_instances(mask, cls))
    return stager.finish()


def stage_yolo_det(
    src: Path,
    out: Path,
    info: SourceInfo,
    names: list[str] | None = None,
    sam_model: str = "sam2.1_b.pt",
    device: str | None = None,
    min_fill: float = 0.1,
) -> SourceInfo:
    """A YOLO detection dataset (D-Fire) turned into masks by prompting SAM 2 with each box.

    A mask that fills less than `min_fill` of its box (SAM missed, typical for thin smoke) falls
    back to the box itself, so the region is still labelled rather than taught as background.
    """
    try:
        from ultralytics import SAM
    except ImportError as exc:
        raise RuntimeError(
            "SAM needs the train extra: uv sync --package ember-fire-seg --extra train"
        ) from exc
    mapping = _mapping(names or dataset_names(src))
    sam = SAM(sam_model)
    stager = Stager(out, info)
    for image in images_under(src):
        rows: list[tuple[int, float, float, float, float]] = []
        for c, cx, cy, w, h in read_boxes(label_for(image)):
            cls = mapping.get(c)
            if cls is not None:
                rows.append((cls, cx, cy, w, h))
        if not rows:
            stager.add(_stem(image, src), image, image.suffix, [])
            continue
        with Image.open(image) as im:
            width, height = im.size
        boxes = [
            [
                (cx - w / 2) * width,
                (cy - h / 2) * height,
                (cx + w / 2) * width,
                (cy + h / 2) * height,
            ]
            for _, cx, cy, w, h in rows
        ]
        kwargs: dict[str, Any] = {"bboxes": boxes, "verbose": False}
        if device is not None:
            kwargs["device"] = device
        result = sam(str(image), **kwargs)[0]
        masks = [] if result.masks is None else list(result.masks.data.cpu().numpy() > 0.5)
        instances: list[Instance] = []
        for k, (cls, cx, cy, w, h) in enumerate(rows):
            found = _sam_instances(
                masks[k] if k < len(masks) else None, boxes[k], (width, height), cls, min_fill
            )
            if found:
                instances += found
            else:
                stager.notes["box_fallbacks"] += 1
                instances.append(Instance(cls, box_polygon(cx, cy, w, h)))
        stager.add(_stem(image, src), image, image.suffix, instances)
    return stager.finish()


def _sam_instances(
    mask: np.ndarray | None,
    box: list[float],
    size: tuple[int, int],
    cls: int,
    min_fill: float,
) -> list[Instance]:
    if mask is None:
        return []
    width, height = size
    if mask.shape != (height, width):
        mask = np.asarray(Image.fromarray(mask).resize((width, height), Image.Resampling.NEAREST))
    x0, y0, x1, y1 = (round(v) for v in box)
    inside = np.zeros_like(mask, dtype=bool)
    inside[max(0, y0) : max(0, y1), max(0, x0) : max(0, x1)] = True
    mask = mask & inside
    if mask.sum() < min_fill * max(1, (x1 - x0) * (y1 - y0)):
        return []
    return mask_instances(mask, cls)


def _mapping(names: Iterable[str]) -> dict[int, int | None]:
    return {i: class_for_name(n) for i, n in enumerate(names)}


def _stem(image: Path, root: Path) -> str:
    return "_".join(image.relative_to(root).with_suffix("").parts)


def _safe(stem: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in stem)[:80]
