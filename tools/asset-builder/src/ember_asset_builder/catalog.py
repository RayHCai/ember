"""Every model the builder writes, keyed by its path under `assets/` (without `.glb`)."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial

from . import buildings, drone, fx, trees
from .gltf import Model
from .preview import View

_FORMS: dict[str, Callable[[int, int], Model]] = {
    "broadleaf": trees.broadleaf,
    "conifer": trees.conifer,
    "palm": trees.palm,
    "umbrella": trees.umbrella,
    "shrub": trees.shrub,
}
_VARIANTS = {"a": 1, "b": 2}


def _trees() -> dict[str, Callable[[], Model]]:
    out: dict[str, Callable[[], Model]] = {}
    for form, build in _FORMS.items():
        for variant, seed in _VARIANTS.items():
            out[f"trees/{form}_{variant}"] = partial(build, seed, 0)
            out[f"trees/{form}_{variant}_lod1"] = partial(build, seed, 1)
    return out


CATALOG: dict[str, Callable[[], Model]] = {
    "drone/quadcopter": drone.quadcopter,
    **_trees(),
    "buildings/house_gable": buildings.house_gable,
    "buildings/house_hip": buildings.house_hip,
    "buildings/shop": buildings.shop,
    "buildings/ruin": buildings.ruin,
    "fx/flame_a": lambda: fx.flame(1, tongues=3, spread=0.17, tallest=1.0),
    "fx/flame_b": lambda: fx.flame(2, tongues=5, spread=0.3, tallest=0.8),
    "fx/flame_c": lambda: fx.flame(3, tongues=6, spread=0.42, tallest=0.5),
    "fx/smoke_a": lambda: fx.smoke(1),
    "fx/smoke_b": lambda: fx.smoke(2),
    "fx/smoke_c": lambda: fx.smoke(3),
}


def _tree_rows() -> list[list[tuple[str, View]]]:
    names = ("{}_a", "{}_b", "{}_a_lod1", "{}_b_lod1")
    return [[(f"trees/{name.format(form)}", View()) for name in names] for form in _FORMS]


# Preview sheets: name -> (tile size in pixels, rows of (model, view)).
SHEETS: dict[str, tuple[int, list[list[tuple[str, View]]]]] = {
    "drone": (
        440,
        [
            [("drone/quadcopter", View(35, 24)), ("drone/quadcopter", View(145, 35))],
            [("drone/quadcopter", View(0, 5)), ("drone/quadcopter", View(0, 89))],
        ],
    ),
    "trees": (260, _tree_rows()),
    "buildings": (
        480,
        [
            [("buildings/house_gable", View(35, 28)), ("buildings/house_hip", View(-35, 28))],
            [("buildings/shop", View(30, 24)), ("buildings/ruin", View(35, 35))],
        ],
    ),
    "fx": (
        300,
        [
            [(f"fx/flame_{v}", View()) for v in "abc"],
            [(f"fx/smoke_{v}", View()) for v in "abc"],
        ],
    ),
}
