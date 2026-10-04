"""Procedural images for the smoke test: blotchy ground with flame, smoke and burned blobs.

They only prove the pipeline runs end to end (stage, assemble, train, export, evaluate); they teach
nothing about real fire.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from .classes import BURNED, FLAME, SMOKE
from .labels import Instance, mask_instances
from .sources import SourceInfo, Stager

GROUNDS = ((70, 110, 50), (110, 100, 60), (90, 80, 55), (60, 90, 45))


def render(rng: np.random.Generator, size: int = 192) -> tuple[NDArray[np.uint8], list[Instance]]:
    base = np.array(GROUNDS[rng.integers(len(GROUNDS))], dtype=np.float64)
    noise = rng.normal(0, 18, (12, 12, 3)).astype(np.float32)
    blotch = np.stack(
        [
            np.asarray(
                Image.fromarray(noise[..., c]).resize((size, size), Image.Resampling.BICUBIC)
            )
            for c in range(3)
        ],
        axis=-1,
    )
    img = base + blotch + rng.normal(0, 6, (size, size, 3))
    yy, xx = np.mgrid[:size, :size]
    instances: list[Instance] = []
    for _ in range(int(rng.integers(0, 4))):
        cls = int(rng.choice([FLAME, SMOKE, BURNED]))
        cx, cy = rng.uniform(0.15, 0.85, 2) * size
        rx, ry = rng.uniform(0.05, 0.2, 2) * size
        angle = rng.uniform(0, np.pi)
        dx, dy = xx - cx, yy - cy
        u = (dx * np.cos(angle) + dy * np.sin(angle)) / rx
        v = (-dx * np.sin(angle) + dy * np.cos(angle)) / ry
        blob = u**2 + v**2 <= 1.0 + 0.15 * np.sin(6 * np.arctan2(v, u))
        if cls == FLAME:
            heat = np.clip(1.2 - np.sqrt(u**2 + v**2), 0, 1)[..., None]
            img[blob] = (np.array([200, 70, 20]) + heat * np.array([55, 170, 60]))[blob]
        elif cls == SMOKE:
            img[blob] = 0.35 * img[blob] + 0.65 * np.array([185, 185, 190])
        else:
            img[blob] = np.array([40, 36, 34]) + rng.normal(0, 8, (int(blob.sum()), 3))
        instances += mask_instances(blob, cls)
    return np.clip(img, 0, 255).astype(np.uint8), instances


def stage_synthetic(out: Path, name: str, count: int, seed: int = 0) -> SourceInfo:
    info = SourceInfo(
        name=name,
        kind="synthetic",
        synthetic=True,
        aerial=True,
        group_block=1,
        license="generated",
        origin="ember_fire_seg.synthetic",
    )
    stager = Stager(out, info)
    rng = np.random.default_rng(seed)
    for i in range(count):
        rgb, instances = render(rng)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="PNG")
        stager.add(f"synthetic_{i}", buf.getvalue(), ".png", instances)
    return stager.finish()
