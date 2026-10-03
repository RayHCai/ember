"""`asset-builder`: write every model in the catalogue, the manifest and the preview sheets."""

from __future__ import annotations

import argparse
import json
import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .catalog import CATALOG, SHEETS
from .gltf import GENERATOR, Model, encode
from .preview import render, sheet, write_png

log = logging.getLogger("asset-builder")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="asset-builder", description="Build Ember's 3D models.")
    parser.add_argument("--out", type=Path, default=Path("assets"), help="directory to write into")
    parser.add_argument("--no-previews", action="store_true", help="skip the preview sheets")
    return parser


def describe(key: str, model: Model) -> dict[str, Any]:
    """Manifest entry: what a consumer needs to know about a model without opening it."""
    low, high = model.bounds()
    return {
        "file": f"{key}.glb",
        "triangles": model.triangles(),
        "min": [round(float(v), 3) for v in low],
        "max": [round(float(v), 3) for v in high],
        "materials": sorted({material for material, _ in model.root.walk()}),
        "nodes": model.node_names(),
        **model.extras,
    }


def build(out: Path, *, previews: bool) -> None:
    models = {key: make() for key, make in CATALOG.items()}
    for key, model in models.items():
        path = out / f"{key}.glb"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encode(model))
        log.info("%s: %d triangles", path.as_posix(), model.triangles())
    manifest = {
        "generator": GENERATOR,
        "assets": {key: describe(key, model) for key, model in models.items()},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=4) + "\n", newline="\n")
    if not previews:
        return
    (out / "previews").mkdir(exist_ok=True)
    for name, (size, rows) in SHEETS.items():
        tiles = [
            [render(models[key], size, view, ground=name != "drone") for key, view in row]
            for row in rows
        ]
        write_png(out / "previews" / f"{name}.png", sheet(tiles))
        log.info("%s", (out / "previews" / f"{name}.png").as_posix())


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    build(args.out, previews=not args.no_previews)
