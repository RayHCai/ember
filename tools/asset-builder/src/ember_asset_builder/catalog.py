"""Every model the builder writes, keyed by its path under `assets/` (without `.glb`)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from functools import partial

from . import drone, fx, terrain, trees
from .commercial import Block, block
from .gltf import Model
from .houses import House, house
from .preview import View
from .ruins import ruin

_FORMS: dict[str, Callable[[int, int], Model]] = {
    "broadleaf": trees.broadleaf,
    "conifer": trees.conifer,
    "palm": trees.palm,
    "umbrella": trees.umbrella,
    "shrub": trees.shrub,
}
_VARIANTS = {"a": 1, "b": 2}
_LODS = ("", "_lod1", "_lod2")

# Wall, roof, accent: the colours a model carries when nobody recolours it.
_SCHEMES = [
    (0xEFE6D2, 0x9A4A3A, 0x7A4A2E),
    (0xD9E2DA, 0x5E6E7A, 0x33566B),
    (0xE8D9A8, 0x4F7A5A, 0x6B3A2A),
    (0xC9D8E2, 0x4A4E54, 0xB5523B),
    (0xF2F0EA, 0x7A5A44, 0x2F6F5E),
    (0xE2D4B4, 0xB5523B, 0x3F5E4E),
    (0xBFC9B8, 0xB8BCC0, 0x7A4A2E),
]
_PAINTS = [0xC7CCD1, 0xB5523B, 0x33566B, 0xF2F0EA, 0x4A4E54]

# Footprints are spaced so any surveyed house is within about a third of one of them.
_HOUSES = [
    House(5, 4, shed=True),
    House(8, 6),
    House(11, 8, hip=True, solar="heater"),
    House(12, 6, lanai=1.0),
    House(14, 10, lanai=0.55, cross=True, solar="heater"),
    House(15, 12, hip=True, carport=4.0, car="sedan", solar="pv"),
    House(17, 9, lanai=1.0, carport=4.2, car="pickup"),
    House(17, 12, lanai=0.55, carport=4.5, cross=True, solar="heater", car="sedan"),
    House(18, 7),
    House(18, 14, hip=True, lanai=0.5, solar="pv"),
    House(21, 11, lanai=0.6, carport=5.0, cross=True, car="sedan"),
    House(22, 15, hip=True, carport=5.0, cross=True, solar="pv", car="pickup"),
    House(26, 10, lanai=1.0, solar="heater"),
    House(27, 15, lanai=0.45, carport=5.5, cross=True, solar="pv", car="sedan"),
    House(33, 13, hip=True, lanai=1.0, solar="pv"),
    House(34, 18, hip=True, carport=6.0, cross=True, solar="pv", car="pickup"),
    House(10, 8, storeys=2),
    House(14, 10, storeys=2, hip=True, lanai=1.0),
    House(18, 12, storeys=2, lanai=0.6, cross=True, solar="pv"),
    House(24, 12, storeys=2, lanai=1.0, carport=5.0, car="sedan"),
    House(28, 16, storeys=2, hip=True, cross=True, solar="pv"),
]

# Frontage by depth: narrow deep shops for a street row, wide blocks, and halls.
_BLOCKS = [
    Block(7, 6, 1, "store"),
    Block(12, 9, 1, "store"),
    Block(12, 20, 1, "store"),
    Block(16, 12, 1, "store"),
    Block(22, 16, 1, "store"),
    Block(8, 13, 2, "shop"),
    Block(11, 9, 2, "shop"),
    Block(13, 18, 2, "shop"),
    Block(18, 12, 2, "office"),
    Block(26, 16, 2, "office"),
    Block(36, 22, 2, "office"),
    Block(22, 11, 3, "lodge"),
    Block(32, 14, 3, "lodge"),
    Block(44, 18, 3, "lodge"),
    Block(30, 20, 1, "hall"),
    Block(24, 34, 1, "hall"),
    Block(42, 28, 1, "hall"),
]

# Length, width, with a burnt-out car.
_RUINS = [(8, 6, False), (14, 10, True), (22, 14, True), (34, 20, False)]


def _size(length: float, width: float, storeys: int = 1) -> str:
    return f"{length:g}x{width:g}" + (f"_{storeys}f" if storeys > 1 else "")


def _trees() -> dict[str, Callable[[], Model]]:
    out: dict[str, Callable[[], Model]] = {}
    for form, build in _FORMS.items():
        for variant, seed in _VARIANTS.items():
            for lod, suffix in enumerate(_LODS):
                out[f"trees/{form}_{variant}{suffix}"] = partial(build, seed, lod)
    return out


def _buildings() -> dict[str, Callable[[], Model]]:
    out: dict[str, Callable[[], Model]] = {}
    for k, base in enumerate(_HOUSES):
        wall, roof, accent = _SCHEMES[k % len(_SCHEMES)]
        paint = _PAINTS[k % len(_PAINTS)]
        spec = replace(base, wall=wall, roof=roof, accent=accent, paint=paint, seed=10 + k)
        name = f"buildings/house_{_size(spec.length, spec.width, spec.storeys)}"
        out[name] = partial(house, spec, 0)
        out[f"{name}_lod1"] = partial(house, spec, 1)
    for k, plain in enumerate(_BLOCKS):
        wall, roof, accent = _SCHEMES[(k + 3) % len(_SCHEMES)]
        deck = roof if plain.style == "shop" else 0x9B9E9C
        tuned = replace(plain, wall=wall, roof=deck, accent=accent, seed=40 + k)
        name = f"buildings/{tuned.style}_{_size(tuned.length, tuned.width, tuned.storeys)}"
        out[name] = partial(block, tuned, 0)
        out[f"{name}_lod1"] = partial(block, tuned, 1)
    for k, (length, width, car) in enumerate(_RUINS):
        name = f"buildings/ruin_{_size(length, width)}"
        out[name] = partial(ruin, length, width, 70 + k, 0, car=car)
        out[f"{name}_lod1"] = partial(ruin, length, width, 70 + k, 1, car=car)
    return out


CATALOG: dict[str, Callable[[], Model]] = {
    "drone/quadcopter": drone.quadcopter,
    "terrain/ground": terrain.ground,
    **_trees(),
    **_buildings(),
    "fx/flame_a": partial(fx.flame, 1, 0, 0.0, 1.0),
    "fx/flame_b": partial(fx.flame, 2, 3, 0.3, 0.8),
    "fx/flame_c": partial(fx.flame, 3, 4, 0.42, 0.5),
    "fx/smoke_a": partial(fx.smoke, 1),
    "fx/smoke_b": partial(fx.smoke, 2),
    "fx/smoke_c": partial(fx.smoke, 3),
}


def _rows(keys: list[str], per_row: int, view: View) -> list[list[tuple[str, View]]]:
    return [[(key, view) for key in keys[k : k + per_row]] for k in range(0, len(keys), per_row)]


def _full(prefix: str) -> list[str]:
    return [key for key in CATALOG if key.startswith(prefix) and "_lod" not in key]


def _tree_rows() -> list[list[tuple[str, View]]]:
    names = ("{}_a", "{}_b", "{}_a_lod1", "{}_a_lod2")
    return [[(f"trees/{name.format(form)}", View(35, 22)) for name in names] for form in _FORMS]


_COMMERCIAL = [key for key in _full("buildings/") if "house_" not in key and "ruin_" not in key]

# Preview sheets: name -> (tile size in pixels, rows of (model, view)).
SHEETS: dict[str, tuple[int, list[list[tuple[str, View]]]]] = {
    "drone": (
        460,
        [
            [("drone/quadcopter", View(35, 24)), ("drone/quadcopter", View(145, 35))],
            [("drone/quadcopter", View(0, 5)), ("drone/quadcopter", View(0, 89))],
        ],
    ),
    "trees": (260, _tree_rows()),
    "houses": (320, _rows(_full("buildings/house_"), 4, View(35, 30))),
    "commercial": (320, _rows(_COMMERCIAL, 4, View(32, 30))),
    "ruins": (320, [[(key, View(35, 38)) for key in _full("buildings/ruin_")]]),
    "fx": (
        300,
        [
            [(f"fx/flame_{v}", View()) for v in "abc"],
            [(f"fx/smoke_{v}", View()) for v in "abc"],
        ],
    ),
}
