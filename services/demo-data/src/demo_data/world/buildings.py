"""Pre-fire buildings as extrudable footprints for the 3D viewer: height from footprint size,
roof colour from the imagery, ignition time and fate from the fire model."""

from __future__ import annotations

import json
import logging
from collections import defaultdict

import numpy as np
from shapely.geometry import Polygon, shape

from ..config import DERIVED_DIR
from ..model.build import FUELS
from .frame import FRAME
from .imagery import sample_imagery
from .vegetation import PRE_LAYER

log = logging.getLogger(__name__)

STRUCTURE_FUEL = 5
GROUP_M = 500.0


def _height_m(area: float, u: float, v: float) -> float:
    if area < 100:
        return 3.0 + 1.0 * u
    if area < 300:
        return 3.4 + 1.2 * u if v < 0.7 else 6.0 + 1.0 * u  # mostly one storey, some two
    if area < 1000:
        return 4.5 + 4.5 * u
    return 6.0 + 5.0 * u


def _ring(geom: dict) -> list[list[float]]:
    g = shape(geom)
    if g.geom_type == "MultiPolygon":
        g = max(g.geoms, key=lambda p: p.area)
    return [list(p) for p in g.exterior.coords]


def build_buildings() -> list[dict]:
    feats = json.loads((DERIVED_DIR / "structures.geojson").read_text())["features"]
    flame_min = float(FUELS[STRUCTURE_FUEL]["flame"])
    items: list[dict] = []
    for f in feats:
        ring = np.array(_ring(f["geometry"]))
        x, y = FRAME.to_local(ring[:, 0], ring[:, 1])
        poly = Polygon(np.stack([x, y], 1)).simplify(0.3, preserve_topology=True)
        if not poly.is_valid or poly.area < 4:
            continue
        p = f["properties"]
        rng = np.random.default_rng(int(p["id"]) + 7919)
        u, v = rng.random(2)
        rect = poly.minimum_rotated_rectangle
        # Near-rectangular houses get a gable roof along their long side; the rest are flat.
        gable = poly.area < 450 and rect.area > 0 and poly.area / rect.area > 0.85
        item = {
            "id": int(p["id"]),
            "footprint": [[round(a, 2), round(b, 2)] for a, b in list(poly.exterior.coords)[:-1]],
            "height_m": round(_height_m(poly.area, u, v), 2),
            "roof": "gable" if gable else "flat",
            "ignition_min": None
            if p["ignition_min"] is None
            else round(float(p["ignition_min"]), 2),
            "flame_min": flame_min,
            "destroyed": p["fate"] == "destroyed",
            "name": p.get("name"),
        }
        if gable:
            rx, ry = rect.exterior.coords.xy
            sides = [np.hypot(rx[i + 1] - rx[i], ry[i + 1] - ry[i]) for i in range(2)]
            long_i = int(np.argmax(sides))
            angle = float(np.arctan2(ry[long_i + 1] - ry[long_i], rx[long_i + 1] - rx[long_i]))
            c = rect.centroid
            item["gable"] = {
                "cx": round(c.x, 2),
                "cy": round(c.y, 2),
                "length_m": round(max(sides), 2),
                "width_m": round(min(sides), 2),
                "angle_rad": round(angle, 4),
            }
        rp = poly.representative_point()
        verts = np.array(poly.exterior.coords)[:-1]
        picks = verts[
            [
                np.argmin(verts[:, 0]),
                np.argmax(verts[:, 0]),
                np.argmin(verts[:, 1]),
                np.argmax(verts[:, 1]),
            ]
        ]
        item["_samples"] = np.vstack([[rp.x, rp.y], rp.coords[0] + 0.5 * (picks - rp.coords[0])])
        items.append(item)

    # Roof colours, sampled per 500 m group so each imagery read stays at full resolution.
    groups: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for item in items:
        sx, sy = item["_samples"][0]
        groups[(int(sx // GROUP_M), int(sy // GROUP_M))].append(item)
    for members in groups.values():
        pts = np.concatenate([m["_samples"] for m in members])
        rgb, have = sample_imagery((PRE_LAYER,), pts[:, 0], pts[:, 1], 1.0)
        k = 0
        for m in members:
            n = len(m["_samples"])
            ok = have[k : k + n]
            colour = (
                np.median(rgb[k : k + n][ok], axis=0) if ok.any() else np.array([0.55, 0.53, 0.5])
            )
            m["roof_rgb"] = [round(float(c), 3) for c in colour]
            k += n
    for item in items:
        del item["_samples"]
    log.info(
        "buildings: %d footprints, %d gable roofs",
        len(items),
        sum(i["roof"] == "gable" for i in items),
    )
    return items
