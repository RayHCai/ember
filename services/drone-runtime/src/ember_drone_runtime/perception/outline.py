"""Region outlines: the boundary of a pixel mask as a short polygon, ready to project.

Outlines run along pixel edges, so vertices are pixel corners (pixel `(r, c)` spans `x in [c, c+1]`,
`y in [r, r+1]`) and a traced ring's area is exactly the component's pixel count. Rings go
clockwise on the image (rows grow downward) from the component's top-left corner, the order
`RiskDetection.ground` uses. Components are 8-connected, like the detectors' labelling; holes are
ignored.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

from ..geo import FloatArray

EIGHT = np.ones((3, 3), dtype=bool)

# Headings east, south, west, north as (dx, dy) with y down; turning right is the next index.
_STEPS = ((1, 0), (0, 1), (-1, 0), (0, -1))
# Per heading, the (row, col) offsets from corner (x, y) of the pixel ahead-left and ahead-right.
_AHEAD = (
    ((-1, 0), (0, 0)),
    ((0, 0), (0, -1)),
    ((0, -1), (-1, -1)),
    ((-1, -1), (-1, 0)),
)


def trace(mask: NDArray[np.bool_]) -> FloatArray:
    """Outer boundary of one 8-connected component as (n, 2) corner points, x then y."""
    rows, cols = np.nonzero(mask)
    if rows.size == 0:
        return np.zeros((0, 2))
    m = np.pad(mask, 1).tolist()
    # Raster order puts the first pixel's top-left corner on the boundary, heading east.
    r0, c0 = int(rows[0]) + 1, int(cols[0]) + 1
    points = [(c0, r0)]
    x, y, h = c0 + 1, r0, 0
    while (x, y) != (c0, r0):
        (lr, lc), (rr, rc) = _AHEAD[h]
        if m[y + lr][x + lc]:
            turn = (h + 3) % 4
        elif m[y + rr][x + rc]:
            turn = h
        else:
            turn = (h + 1) % 4
        if turn != h:
            points.append((x, y))
            h = turn
        dx, dy = _STEPS[h]
        x, y = x + dx, y + dy
    ring: FloatArray = np.array(points, dtype=np.float64) - 1.0
    return ring


def simplify(ring: FloatArray, max_points: int = 32, tolerance: float = 0.75) -> FloatArray:
    """Douglas-Peucker on a closed ring longer than `max_points`, loosening the tolerance until at
    most that many stay. The first point always stays, and at least three do."""
    if len(ring) <= max_points:
        return ring
    tol = tolerance
    while True:
        out = _simplify_closed(ring, tol)
        if len(out) <= max_points:
            return out
        tol *= 1.5


def components(mask: NDArray[np.bool_], min_pixels: int = 1) -> list[NDArray[np.bool_]]:
    """8-connected components with at least `min_pixels`, largest first."""
    labels, n = ndimage.label(mask, structure=EIGHT)
    if n == 0:
        return []
    sizes = np.bincount(labels.ravel())[1:]
    order = [int(i) for i in np.argsort(-sizes, kind="stable") if sizes[i] >= min_pixels]
    return [labels == i + 1 for i in order]


def outline(mask: NDArray[np.bool_], max_points: int = 32) -> FloatArray | None:
    """Simplified outline of the largest component; None for an empty mask."""
    parts = components(mask)
    if not parts:
        return None
    return simplify(trace(parts[0]), max_points)


def _simplify_closed(ring: FloatArray, tol: float) -> FloatArray:
    far = int(np.argmax(np.hypot(*(ring - ring[0]).T)))
    if far == 0:
        return ring[:1]
    closed = np.vstack([ring, ring[:1]])
    keep = np.zeros(len(closed), dtype=bool)
    keep[[0, far, len(closed) - 1]] = True
    stack = [(0, far), (far, len(closed) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = closed[b] - closed[a]
        rel = closed[a + 1 : b] - closed[a]
        norm = float(np.hypot(*seg))
        if norm == 0.0:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            dist = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / norm
        i = int(np.argmax(dist))
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    if keep[:-1].sum() < 3:
        seg = closed[far] - closed[0]
        rel = closed[:-1] - closed[0]
        keep[int(np.argmax(np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0])))] = True
    out: FloatArray = closed[:-1][keep[:-1]]
    return out
