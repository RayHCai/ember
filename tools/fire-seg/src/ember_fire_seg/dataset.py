"""Assemble staged sources into one Ultralytics dataset with a held-out test set.

Splits are decided per group of images (a video's consecutive frames stay together) by hashing the
group with the seed, so they are stable as sources grow and never leak near-duplicates across
splits. The test split takes only from the sources named for it (real aerial footage); synthetic
sources are capped to a share of train and val. The dataset's version is a hash of its contents,
recorded in `manifest.json` and in every model card trained from it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .classes import CLASSES
from .labels import read_seg
from .sources import IMAGE_SUFFIXES, SourceInfo, read_info, staged

SPLITS = ("train", "val", "test")


def unit_hash(*parts: object) -> float:
    digest = hashlib.sha256(":".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def split_source(
    info: SourceInfo,
    images: list[Path],
    test: bool,
    test_frac: float,
    val_frac: float,
    seed: int,
) -> dict[str, list[Path]]:
    out: dict[str, list[Path]] = {s: [] for s in SPLITS}
    for i, image in enumerate(images):
        group = i // max(1, info.group_block)
        if test and unit_hash(seed, "test", info.name, group) < test_frac:
            out["test"].append(image)
        elif unit_hash(seed, "val", info.name, group) < val_frac:
            out["val"].append(image)
        else:
            out["train"].append(image)
    return out


def cap_synthetic(
    picks: dict[str, dict[str, list[Path]]],
    infos: dict[str, SourceInfo],
    cap: float,
    seed: int,
) -> None:
    """Drop synthetic images from train and val until they are at most `cap` of each split."""
    for split in ("train", "val"):
        real = sum(len(p[split]) for n, p in picks.items() if not infos[n].synthetic)
        synthetic = [(n, img) for n, p in picks.items() if infos[n].synthetic for img in p[split]]
        if cap >= 1.0 or not synthetic:
            continue
        if real == 0:
            raise ValueError(
                f"{split}: only synthetic images; stage real sources or pass --synthetic-cap 1"
            )
        allowed = int(cap / (1.0 - cap) * real)
        keep = set(sorted(synthetic, key=lambda s: unit_hash(seed, "cap", *s))[:allowed])
        for n in picks:
            if infos[n].synthetic:
                picks[n][split] = [img for img in picks[n][split] if (n, img) in keep]


def assemble(
    root: Path,
    out: Path,
    sources: list[str] | None = None,
    test_sources: list[str] | None = None,
    test_frac: float = 0.25,
    val_frac: float = 0.1,
    synthetic_cap: float = 0.3,
    seed: int = 0,
) -> dict[str, Any]:
    dirs = {p.name: p for p in staged(root)}
    names = sources or sorted(dirs)
    missing = sorted(set(names) - set(dirs))
    if missing:
        raise FileNotFoundError(f"not staged under {root / 'sources'}: {', '.join(missing)}")
    infos = {n: read_info(dirs[n]) for n in names}
    test_from = set(
        test_sources
        if test_sources is not None
        else [n for n in names if infos[n].aerial and not infos[n].synthetic]
    )
    unknown = sorted(test_from - set(names))
    if unknown:
        raise ValueError(f"test sources not in the dataset: {', '.join(unknown)}")
    picks = {
        n: split_source(
            infos[n],
            sorted(p for p in (dirs[n] / "images").iterdir() if p.suffix.lower() in IMAGE_SUFFIXES),
            n in test_from,
            test_frac,
            val_frac,
            seed,
        )
        for n in names
    }
    cap_synthetic(picks, infos, synthetic_cap, seed)

    if out.exists():
        shutil.rmtree(out)
    counts: dict[str, dict[str, int]] = {s: {} for s in SPLITS}
    classes: dict[str, Counter[str]] = defaultdict(Counter)
    fingerprint = hashlib.sha256()
    for n in names:
        for split in SPLITS:
            for image in picks[n][split]:
                label = dirs[n] / "labels" / f"{image.stem}.txt"
                target = f"{n}__{image.name}"
                _link(image, out / "images" / split / target)
                _link(label, out / "labels" / split / f"{n}__{image.stem}.txt")
                classes[split].update(CLASSES[i.cls] for i in read_seg(label))
                fingerprint.update(f"{split}/{target}:{image.stat().st_size}:".encode())
                fingerprint.update(label.read_bytes())
            counts[split][n] = len(picks[n][split])

    version = fingerprint.hexdigest()[:12]
    data_yaml = "\n".join(
        [
            f"path: {out.resolve().as_posix()}",
            "train: images/train",
            "val: images/val",
            "test: images/test",
            "names:",
            *(f"  {i}: {c}" for i, c in enumerate(CLASSES)),
            "",
        ]
    )
    (out / "data.yaml").write_text(data_yaml)
    manifest: dict[str, Any] = {
        "version": version,
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "classes": list(CLASSES),
        "seed": seed,
        "test_frac": test_frac,
        "val_frac": val_frac,
        "synthetic_cap": synthetic_cap,
        "test_sources": sorted(test_from),
        "images": counts,
        "instances": {s: dict(sorted(classes[s].items())) for s in SPLITS},
        "sources": {n: asdict(infos[n]) for n in names},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def _link(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)
