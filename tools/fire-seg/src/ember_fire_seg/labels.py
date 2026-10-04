"""Ultralytics YOLO segmentation labels: one `cls x1 y1 x2 y2 ...` line per instance, coordinates
normalised to the image. Masks become instances through drone-runtime's tracer, so training labels
and the drone's outlines share one geometry.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from ember_drone_runtime.geo import FloatArray, inside_polygon
from ember_drone_runtime.perception.outline import components, simplify, trace
from numpy.typing import NDArray

# Speckle smaller than this many pixels is not labelled.
MIN_PIXELS = 12
# Vertices per labelled instance; finer than the drone's 32 so the model learns real edges.
LABEL_POINTS = 64

Mask = NDArray[np.bool_]


@dataclass(frozen=True)
class Instance:
    cls: int
    # (n, 2) x then y, normalised to 0..1.
    polygon: FloatArray


def read_seg(path: Path) -> list[Instance]:
    """Instances of a segmentation label file; missing file means no instances."""
    if not path.is_file():
        return []
    out = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 7 or len(parts) % 2 == 0:
            continue
        coords = np.array([float(v) for v in parts[1:]]).reshape(-1, 2)
        out.append(Instance(int(parts[0]), coords))
    return out


def read_boxes(path: Path) -> list[tuple[int, float, float, float, float]]:
    """`cls cx cy w h` rows of a detection label file, normalised."""
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        cx, cy, w, h = (float(v) for v in parts[1:])
        rows.append((int(parts[0]), cx, cy, w, h))
    return rows


def write_seg(path: Path, instances: list[Instance]) -> None:
    lines = [
        " ".join([str(i.cls), *(f"{v:.5f}" for v in np.clip(i.polygon, 0, 1).ravel())])
        for i in instances
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + ("\n" if lines else ""))


def box_polygon(cx: float, cy: float, w: float, h: float) -> FloatArray:
    x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])


def mask_instances(
    mask: Mask, cls: int, min_pixels: int = MIN_PIXELS, max_points: int = LABEL_POINTS
) -> list[Instance]:
    """One instance per connected region of the mask, outer boundary only."""
    h, w = mask.shape
    scale = np.array([w, h], dtype=np.float64)
    return [
        Instance(cls, simplify(trace(part), max_points) / scale)
        for part in components(mask, min_pixels)
    ]


def rasterize(polygon_px: FloatArray, shape: tuple[int, int]) -> Mask:
    """Pixels whose centres fall inside the polygon (pixel coordinates, x then y)."""
    h, w = shape
    out = np.zeros(shape, dtype=bool)
    if len(polygon_px) < 3:
        return out
    x0, y0 = np.floor(polygon_px.min(axis=0)).astype(int)
    x1, y1 = np.ceil(polygon_px.max(axis=0)).astype(int)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    if x0 >= x1 or y0 >= y1:
        return out
    yy, xx = np.mgrid[y0:y1, x0:x1]
    out[y0:y1, x0:x1] = inside_polygon(xx + 0.5, yy + 0.5, polygon_px)
    return out


def class_mask(instances: list[Instance], cls: int, shape: tuple[int, int]) -> Mask:
    """Union of one class's instances as a pixel mask."""
    h, w = shape
    out = np.zeros(shape, dtype=bool)
    for inst in instances:
        if inst.cls == cls:
            out |= rasterize(inst.polygon * np.array([w, h]), shape)
    return out
