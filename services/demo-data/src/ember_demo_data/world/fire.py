"""The fire model's per-cell timing, resampled onto a world-frame grid.

The viewer evaluates the same flame / smoulder / burned-out curves as `model.state` on the
GPU from these static fields, so fire animates smoothly with the scenario clock without
fetching a new state every minute.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..model.build import FUELS
from .frame import EXTENT
from .layers import NEVER, ground_layers

CELL_M = 10.0
LAYOUT = (
    "float32 RGBA per cell (arrival_min, flame_min, smoulder_min, heat), then one uint8 fuel "
    "class per "
    "cell; little-endian; rows run south to north, columns west to east"
)


def build_fire_grid() -> tuple[dict[str, Any], bytes]:
    L = ground_layers()
    nx, ny = round(EXTENT.width / CELL_M), round(EXTENT.height / CELL_M)
    xs = EXTENT.min_x + (np.arange(nx) + 0.5) * CELL_M
    ys = EXTENT.min_y + (np.arange(ny) + 0.5) * CELL_M
    X, Y = np.meshgrid(xs, ys)
    r, c, inside = L.cells(X, Y)
    arrival = np.where(inside, L.arrival[r, c], NEVER)
    heat = np.where(inside, L.heat[r, c], 0.0)
    flame = np.where(inside, L.flame_min[r, c], 0.0)
    smoulder = np.where(inside, L.smoulder_min[r, c], 0.0)
    fuel = np.where(inside, L.fuel[r, c], 0).astype(np.uint8)
    rgba = np.stack([arrival, flame, smoulder, heat], -1).astype("<f4")
    meta = {
        "width": nx,
        "height": ny,
        "cell_m": CELL_M,
        "extent": EXTENT.as_dict(),
        "layout": LAYOUT,
        "never_min": NEVER,
        "fuels": {str(k): v["name"] for k, v in FUELS.items()},
    }
    return meta, rgba.tobytes() + fuel.tobytes()
