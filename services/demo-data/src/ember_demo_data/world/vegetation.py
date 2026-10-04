"""Individual trees and shrubs reconstructed from the aerial imagery, for the 3D viewer.

Land cover decides where vegetation may stand; the ~1 m pre-fire imagery decides where each
tree is and what it looks like:

1. Canopy: pixels that are green, darker than open grass and textured (crowns shade
   themselves). Thresholds are strict where trees are rare (grassland) and loose where they
   are expected (tree cover). Water, buildings, roads and bare ground never carry trees.
2. Crowns: sunlit local maxima inside the canopy, packed greedily from the widest crown down,
   so one big canopy becomes a few broad trees and a thicket becomes many small ones.
3. Each tree gets a growth form from land cover, crown size and distance to the sea, a height
   from that form's allometry, the crown colour of the imagery under it, the fire arrival
   time of its cell, and whether green canopy is still there in the post-fire imagery.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from scipy import ndimage

from .frame import EXTENT
from .imagery import sample_imagery
from .layers import (
    BUILT_UP,
    CROPLAND,
    GRASSLAND,
    MANGROVES,
    NEVER,
    SHRUBLAND,
    TREE_COVER,
    WATER_FUEL,
    WETLAND,
    ground_layers,
    road_mask,
)

log = logging.getLogger(__name__)

FIELDS = (
    "x",
    "y",
    "height_m",
    "crown_radius_m",
    "form",
    "r",
    "g",
    "b",
    "arrival_min",
    "flame_min",
    "survives",
    "seed",
)
FORMS = ("broadleaf", "conifer", "palm", "umbrella", "shrub")
BROADLEAF, CONIFER, PALM, UMBRELLA, SHRUB = range(len(FORMS))

RES_M = 1.0
BLOCK_M = 400.0
MARGIN_M = 16.0
MAX_CROWN_M = 11.0
PRE_LAYER = "pre_2020"
POST_LAYERS = ("maxar_20230812", "maxar_20230809")

# Per land-cover class: (min greenness, max brightness, min texture). Classes not listed
# (bare, built-over water, snow, moss) never carry trees.
GATES = {
    TREE_COVER: (0.10, 0.37, 0.018),
    MANGROVES: (0.10, 0.37, 0.018),
    SHRUBLAND: (0.12, 0.35, 0.020),
    WETLAND: (0.14, 0.33, 0.022),
    BUILT_UP: (0.12, 0.35, 0.024),
    GRASSLAND: (0.18, 0.31, 0.028),
    CROPLAND: (0.18, 0.31, 0.028),
}


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.tanh(0.5 * x))


def canopy_mask(
    rgb: np.ndarray,
    valid: np.ndarray,
    landcover: np.ndarray,
    blocked: np.ndarray,
    res: float = RES_M,
) -> tuple[np.ndarray, np.ndarray]:
    """Boolean canopy mask and luminance for an imagery block (H, W, 3 floats 0..1)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    exg = (2 * g - r - b) / (r + g + b + 1e-3)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    k = max(3, round(4 / res))
    mean = ndimage.uniform_filter(lum, k)
    texture = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, k) - mean * mean, 0.0))
    surround = ndimage.uniform_filter(lum, int(30 / res))

    e0 = np.full(landcover.shape, 9.0, dtype=np.float32)
    l0 = np.zeros(landcover.shape, dtype=np.float32)
    t0 = np.full(landcover.shape, 9.0, dtype=np.float32)
    for code, (a, c, d) in GATES.items():
        m = landcover == code
        e0[m], l0[m], t0[m] = a, c, d
    # Decide on crown-sized blobs, not single pixels.
    exg_s = ndimage.gaussian_filter(exg, 1.0 / res)
    lum_s = ndimage.gaussian_filter(lum, 1.0 / res)
    p = (
        _sigmoid((exg_s - e0) / 0.03)
        * _sigmoid((l0 - lum_s) / 0.03)
        * _sigmoid((texture - t0) / 0.008)
    )
    # Crowns shade themselves, so canopy reads darker than the open ground around it.
    p *= 0.5 + 0.5 * _sigmoid((surround - lum_s + 0.02) / 0.03)
    mask = (p > 0.3) & valid & ~blocked
    mask = ndimage.binary_opening(mask, iterations=1)
    lab, n = ndimage.label(mask)
    if n:
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        mask &= np.isin(lab, 1 + np.nonzero(sizes * res * res >= 6.0)[0])
    return mask, lum


def crowns(mask: np.ndarray, lum: np.ndarray, res: float = RES_M) -> tuple[np.ndarray, np.ndarray]:
    """Crown centres (col, row in pixels) and radii (m) packed into a canopy mask."""
    dt = ndimage.distance_transform_edt(mask) * res
    score = ndimage.gaussian_filter(lum, 1.2 / res) + 0.02 * dt
    k = max(3, round(3.0 / res) | 1)
    peaks = (score == ndimage.maximum_filter(score, size=k)) & mask & (dt >= 0.9)
    rows, cols = np.nonzero(peaks)
    if rows.size == 0:
        return np.zeros((0, 2)), np.zeros(0)
    want = np.clip(0.75 * dt[rows, cols] + 1.5, 1.2, MAX_CROWN_M)
    pts = np.stack([cols, rows], 1).astype(np.float64) * res
    cell = 2 * MAX_CROWN_M
    grid: dict[tuple[int, int], list[int]] = {}
    accepted: list[int] = []
    for i in np.argsort(-want, kind="stable"):
        x, y, r = pts[i, 0], pts[i, 1], want[i]
        gx, gy = int(x // cell), int(y // cell)
        clear = True
        for j in (
            j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((gx + dx, gy + dy), ())
        ):
            if math.hypot(x - pts[j, 0], y - pts[j, 1]) < 0.75 * max(r, want[j]):
                clear = False
                break
        if clear:
            accepted.append(int(i))
            grid.setdefault((gx, gy), []).append(int(i))
    idx = np.array(accepted, dtype=np.int64)
    centres, radius = pts[idx], want[idx]
    if len(idx) >= 2:
        from scipy.spatial import cKDTree

        d, _ = cKDTree(centres).query(centres, k=2)
        radius = np.minimum(radius, 0.7 * d[:, 1] + 0.6)
    return centres / res, np.clip(radius, 1.0, MAX_CROWN_M)


def growth_forms(
    landcover: np.ndarray, radius: np.ndarray, coast_m: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    """Plausible growth form per tree; palms favour the coast and town, conifers stay rare."""
    n = len(radius)
    weights = np.zeros((n, len(FORMS)))
    wild = np.isin(landcover, (TREE_COVER, MANGROVES))
    weights[wild] = (0.45, 0.12, 0.08, 0.35, 0.0)
    scrub = np.isin(landcover, (SHRUBLAND, WETLAND))
    weights[scrub] = (0.1, 0.0, 0.0, 0.5, 0.4)
    open_land = np.isin(landcover, (GRASSLAND, CROPLAND))
    weights[open_land] = (0.25, 0.03, 0.02, 0.55, 0.15)
    town = landcover == BUILT_UP
    weights[town] = (0.45, 0.15, 0.35, 0.05, 0.0)
    weights[town & (radius > 4.5), BROADLEAF] += 0.5
    weights[:, PALM] += np.where(coast_m < 300, 0.3, 0.0) * (wild | town)
    weights[radius < 1.8] = (0.0, 0.0, 0.15, 0.0, 0.85)
    weights[radius > 6.0, SHRUB] = 0.0
    weights[radius > 6.0, PALM] = 0.0
    weights[weights.sum(1) == 0, BROADLEAF] = 1.0
    cum = np.cumsum(weights / weights.sum(1, keepdims=True), axis=1)
    return np.minimum((rng.random(n)[:, None] > cum).sum(1), len(FORMS) - 1)


def heights(form: np.ndarray, radius: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    n = len(form)
    h = np.empty(n)
    noise = rng.normal(0.0, 1.0, n)
    u = rng.random(n)
    rules = {
        BROADLEAF: (2.0 * radius + 3.0 + 1.5 * noise, 4.0, 24.0),
        CONIFER: (3.2 * radius + 6.0 + 2.0 * noise, 8.0, 32.0),
        PALM: (7.0 + 10.0 * u + 0.6 * radius, 6.0, 22.0),
        UMBRELLA: (1.2 * radius + 2.5 + 0.8 * noise, 3.0, 10.0),
        SHRUB: (0.8 * radius + 0.8 + 0.3 * noise, 0.8, 3.5),
    }
    for f, (value, lo, hi) in rules.items():
        m = form == f
        h[m] = np.clip(value[m], lo, hi)
    return h


def _coast_distance_m() -> np.ndarray:
    L = ground_layers()
    return np.asarray(ndimage.distance_transform_edt(L.fuel != WATER_FUEL)) * 10.0


def _block(bx: float, by: float, coast: np.ndarray, rng: np.random.Generator) -> np.ndarray | None:
    L = ground_layers()
    n = round((BLOCK_M + 2 * MARGIN_M) / RES_M)
    x0, y_top = bx - MARGIN_M, by + BLOCK_M + MARGIN_M
    xs = x0 + (np.arange(n) + 0.5) * RES_M
    ys = y_top - (np.arange(n) + 0.5) * RES_M
    X, Y = np.meshgrid(xs, ys)
    r, c, inside = L.cells(X, Y)
    fuel = np.where(inside, L.fuel[r, c], WATER_FUEL)
    if (fuel == WATER_FUEL).all():
        return None
    landcover = np.where(inside, L.worldcover[r, c], 0)
    blocked = (fuel == WATER_FUEL) | L.building(X, Y) | road_mask(x0, y_top, n, RES_M)
    rgb, valid = sample_imagery((PRE_LAYER,), X, Y, RES_M)
    mask, lum = canopy_mask(rgb, valid, landcover, blocked)
    centres, radius = crowns(mask, lum)
    if len(radius) == 0:
        return None
    col, row = centres[:, 0], centres[:, 1]
    tx, ty = x0 + (col + 0.5) * RES_M, y_top - (row + 0.5) * RES_M
    keep = (tx >= bx) & (tx < bx + BLOCK_M) & (ty >= by) & (ty < by + BLOCK_M)
    # The last row and column of blocks overhang the coverage extent.
    keep &= (tx >= EXTENT.min_x) & (tx < EXTENT.max_x) & (ty >= EXTENT.min_y) & (ty < EXTENT.max_y)
    tx, ty, radius, col, row = tx[keep], ty[keep], radius[keep], col[keep], row[keep]
    if len(tx) == 0:
        return None
    ri, ci = np.round(row).astype(np.int64), np.round(col).astype(np.int64)
    smooth = np.stack([ndimage.gaussian_filter(rgb[..., k], 1.5) for k in range(3)], -1)
    colour = smooth[ri, ci]
    gr, gc, _ = L.cells(tx, ty)
    lc = L.worldcover[gr, gc]
    form = growth_forms(lc, radius, coast[gr, gc], rng)
    height = heights(form, radius, rng)
    arrival = L.arrival[gr, gc]
    flame = L.flame_min[gr, gc]
    # Green canopy still visible after the fire means the tree survived (scorched at most).
    ox = np.array([0.0, 0.4, -0.4, 0.0, 0.0])
    oy = np.array([0.0, 0.0, 0.0, 0.4, -0.4])
    px = tx[:, None] + ox[None, :] * radius[:, None]
    py = ty[:, None] + oy[None, :] * radius[:, None]
    post, have_post = sample_imagery(POST_LAYERS, px, py, RES_M)
    post = (
        np.where(have_post[..., None], post, 0.0).sum(1) / np.maximum(have_post.sum(1), 1)[:, None]
    )
    pr, pg, pb = post[:, 0], post[:, 1], post[:, 2]
    post_exg = (2 * pg - pr - pb) / (pr + pg + pb + 1e-3)
    post_lum = 0.299 * pr + 0.587 * pg + 0.114 * pb
    survives = (arrival >= NEVER) | ((post_exg > 0.06) & (post_lum < 0.5) & have_post.any(1))
    seed = rng.random(len(tx))
    return np.stack(
        [
            tx,
            ty,
            height,
            radius,
            form,
            colour[:, 0],
            colour[:, 1],
            colour[:, 2],
            arrival,
            flame,
            survives.astype(np.float64),
            seed,
        ],
        1,
    ).astype(np.float32)


def build_vegetation() -> np.ndarray:
    """All trees in the coverage area as an (N, len(FIELDS)) float32 array."""
    coast = _coast_distance_m()
    out = []
    bxs = np.arange(EXTENT.min_x, EXTENT.max_x, BLOCK_M)
    bys = np.arange(EXTENT.min_y, EXTENT.max_y, BLOCK_M)
    for i, bx in enumerate(bxs):
        for j, by in enumerate(bys):
            rng = np.random.default_rng((20230808, i, j))
            block = _block(float(bx), float(by), coast, rng)
            if block is not None:
                out.append(block)
        log.info(
            "vegetation: column %d/%d, %d trees so far", i + 1, len(bxs), sum(len(b) for b in out)
        )
    trees = np.concatenate(out) if out else np.zeros((0, len(FIELDS)), dtype=np.float32)
    forms = np.bincount(trees[:, FIELDS.index("form")].astype(np.int64), minlength=len(FORMS))
    log.info(
        "vegetation: %d trees (%s)",
        len(trees),
        ", ".join(f"{f} {k}" for f, k in zip(FORMS, forms, strict=False)),
    )
    return trees
