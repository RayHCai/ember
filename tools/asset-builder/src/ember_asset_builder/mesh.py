"""Triangle-soup meshes and the low-poly primitives every model is built from.

Axes are glTF's: metres, +Y up, +Z forward. Rings list their points turning from +X towards +Z,
which is the order `loft` needs to wind its faces outwards.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import cache
from itertools import pairwise
from typing import Literal

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]
Rgb = tuple[float, float, float]
Axis = Literal["x", "y", "z"]


def linear(hex_rgb: int) -> Rgb:
    """sRGB hex colour as the linear RGB that glTF colour factors use."""

    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

    return (channel(hex_rgb >> 16 & 255), channel(hex_rgb >> 8 & 255), channel(hex_rgb & 255))


def rotation(axis: Axis, deg: float) -> Array:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    if axis == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)
    if axis == "y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


@dataclass(frozen=True)
class Mesh:
    """Triangles wound counter-clockwise seen from outside, each with a tint on its material."""

    tris: Array
    tint: Array

    @staticmethod
    def of(tris: Array) -> Mesh:
        t = np.asarray(tris, dtype=np.float64).reshape(-1, 3, 3)
        return Mesh(t, np.ones((len(t), 3))).solid()

    @staticmethod
    def join(parts: Sequence[Mesh]) -> Mesh:
        return Mesh(
            np.concatenate([p.tris for p in parts]), np.concatenate([p.tint for p in parts])
        )

    def keep(self, mask: NDArray[np.bool_]) -> Mesh:
        return Mesh(self.tris[mask], self.tint[mask])

    def solid(self) -> Mesh:
        """Without the triangles that have collapsed to a line or a point."""
        edges = np.cross(self.tris[:, 1] - self.tris[:, 0], self.tris[:, 2] - self.tris[:, 0])
        return self.keep(np.linalg.norm(edges, axis=1) > 1e-10)

    def normals(self) -> Array:
        n = np.cross(self.tris[:, 1] - self.tris[:, 0], self.tris[:, 2] - self.tris[:, 0])
        unit: Array = n / np.linalg.norm(n, axis=1, keepdims=True)
        return unit

    def centres(self) -> Array:
        mean: Array = self.tris.mean(axis=1)
        return mean

    def map(self, m: Array) -> Mesh:
        tris = self.tris @ m.T
        # A mirror turns every face inside out; reversing the corners turns it back.
        if np.linalg.det(m) < 0:
            tris = tris[:, ::-1]
        return Mesh(tris, self.tint).solid()

    def move(self, x: float = 0.0, y: float = 0.0, z: float = 0.0) -> Mesh:
        return Mesh(self.tris + np.array([x, y, z]), self.tint)

    def scale(self, x: float, y: float | None = None, z: float | None = None) -> Mesh:
        return self.map(np.diag([x, x if y is None else y, x if z is None else z]))

    def turn(self, axis: Axis, deg: float) -> Mesh:
        return self.map(rotation(axis, deg))

    def warp(self, fn: Callable[[Array], Array]) -> Mesh:
        """Move every corner through `fn`, which maps (n, 3) points to (n, 3) points."""
        return Mesh(fn(self.tris.reshape(-1, 3)).reshape(-1, 3, 3), self.tint).solid()

    def shade(self, tint: Array | Rgb | float) -> Mesh:
        return Mesh(self.tris, self.tint * np.asarray(tint, dtype=np.float64))

    def graded(self, bottom: Rgb | float, top: Rgb | float) -> Mesh:
        """Tint running from `bottom` at the lowest face to `top` at the highest."""
        y = self.centres()[:, 1]
        t = ((y - y.min()) / max(float(np.ptp(y)), 1e-9))[:, None]
        lo, hi = np.asarray(bottom, dtype=np.float64), np.asarray(top, dtype=np.float64)
        return self.shade(lo + (hi - lo) * t)

    def under(self, dark: float) -> Mesh:
        """Darken faces by how far they turn to the ground, down to `dark` facing straight down."""
        up = (self.normals()[:, 1:2] + 1) / 2
        return self.shade(dark + (1 - dark) * up)

    def speckle(self, rng: random.Random, amount: float) -> Mesh:
        """Darken each face by a random share of `amount`, so neighbouring facets differ."""
        return self.shade(np.array([[1 - amount * rng.random()] for _ in self.tris]))


def ring(
    n: int,
    rx: float,
    y: float = 0.0,
    rz: float | None = None,
    *,
    phase: float = 0.0,
    at: tuple[float, float] = (0.0, 0.0),
) -> Array:
    """`n` points of a horizontal ellipse at height `y`, starting `phase` degrees from +X."""
    a = math.radians(phase) + np.arange(n) * (2 * math.pi / n)
    z = (rx if rz is None else rz) * np.sin(a)
    return np.stack([at[0] + rx * np.cos(a), np.full(n, y), at[1] + z], axis=1)


def rect(w: float, d: float, y: float = 0.0, *, at: tuple[float, float] = (0.0, 0.0)) -> Array:
    """Corners of a horizontal `w` by `d` rectangle, as a ring."""
    x, z = w / 2, d / 2
    corners = np.array([[x, y, z], [-x, y, z], [-x, y, -z], [x, y, -z]], dtype=np.float64)
    moved: Array = corners + np.array([at[0], 0.0, at[1]])
    return moved


def cap(points: Array, *, up: bool) -> Mesh:
    """A convex ring filled in as a fan, facing up or down."""
    first = np.broadcast_to(points[0], (len(points) - 2, 3))
    a, b = points[1:-1], points[2:]
    return Mesh.of(np.stack([first, b, a] if up else [first, a, b], axis=1))


def face(points: Sequence[Sequence[float]] | Array, towards: Sequence[float]) -> Mesh:
    """Flat convex polygon, wound so that it faces `towards`."""
    p = np.asarray(points, dtype=np.float64)
    if float(np.cross(p[1] - p[0], p[2] - p[0]) @ np.asarray(towards, dtype=np.float64)) < 0:
        p = p[::-1]
    first = np.broadcast_to(p[0], (len(p) - 2, 3))
    return Mesh.of(np.stack([first, p[1:-1], p[2:]], axis=1))


def slab(top: Sequence[Sequence[float]] | Array, thickness: float) -> tuple[Mesh, Mesh]:
    """A convex polygon given thickness downwards, as (upper face, edges and underside)."""
    upper = np.asarray(top, dtype=np.float64)
    lower = upper - np.array([0.0, thickness, 0.0])
    middle = upper.mean(axis=0)
    rest = [face(lower, (0.0, -1.0, 0.0)).shade(0.7)]
    for i in range(len(upper)):
        j = (i + 1) % len(upper)
        outwards = (upper[i] + upper[j]) / 2 - middle
        rest.append(face([upper[i], upper[j], lower[j], lower[i]], outwards))
    return face(upper, (0.0, 1.0, 0.0)), Mesh.join(rest)


def loft(rings: Sequence[Array], *, bottom: bool = False, top: bool = False) -> Mesh:
    """Skin between consecutive rings of equal point count; a ring shrunk to a point makes a tip."""
    parts: list[Mesh] = []
    for lo, hi in pairwise(rings):
        lo1, hi1 = np.roll(lo, -1, axis=0), np.roll(hi, -1, axis=0)
        parts.append(Mesh.of(np.stack([lo, hi, hi1], axis=1)))
        parts.append(Mesh.of(np.stack([lo, hi1, lo1], axis=1)))
    if bottom:
        parts.append(cap(rings[0], up=False))
    if top:
        parts.append(cap(rings[-1], up=True))
    return Mesh.join(parts)


def box(w: float, h: float, d: float, *, bevel: float = 0.0) -> Mesh:
    """Box centred on the origin; `bevel` chamfers the top and bottom edges."""
    if bevel == 0.0:
        return loft([rect(w, d, -h / 2), rect(w, d, h / 2)], bottom=True, top=True)
    inner = (w - 2 * bevel, d - 2 * bevel)
    return loft(
        [
            rect(*inner, -h / 2),
            rect(w, d, -h / 2 + bevel),
            rect(w, d, h / 2 - bevel),
            rect(*inner, h / 2),
        ],
        bottom=True,
        top=True,
    )


def cylinder(sides: int, r: float, h: float, *, r_top: float | None = None) -> Mesh:
    """Closed prism standing on y = 0."""
    return loft(
        [ring(sides, r), ring(sides, r if r_top is None else r_top, h)], bottom=True, top=True
    )


def tube(
    path: Sequence[Sequence[float]] | Array,
    radii: Sequence[float] | float,
    sides: int,
    *,
    bottom: bool = False,
    top: bool = False,
) -> Mesh:
    """Rings of the given radii strung along a path: trunks, branches, arms, struts."""
    p = np.asarray(path, dtype=np.float64)
    r = np.broadcast_to(np.asarray(radii, dtype=np.float64), (len(p),))
    tangents = np.gradient(p, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1, keepdims=True)
    u = np.array([0.0, 0.0, 1.0]) if abs(tangents[0][0]) > 0.9 else np.array([1.0, 0.0, 0.0])
    a = np.arange(sides) * (2 * math.pi / sides)
    rings: list[Array] = []
    for point, t, radius in zip(p, tangents, r, strict=True):
        # Carrying `u` from ring to ring keeps the tube from twisting along a bent path.
        u = u - t * float(u @ t)
        u = u / np.linalg.norm(u)
        v = np.cross(u, t)
        rings.append(point + radius * (np.outer(np.cos(a), u) + np.outer(np.sin(a), v)))
    return loft(rings, bottom=bottom, top=top)


@cache
def _icosphere(level: int) -> tuple[Array, NDArray[np.int64]]:
    t = (1 + math.sqrt(5)) / 2
    verts: list[tuple[float, float, float]] = [
        (-1, t, 0),
        (1, t, 0),
        (-1, -t, 0),
        (1, -t, 0),
        (0, -1, t),
        (0, 1, t),
        (0, -1, -t),
        (0, 1, -t),
        (t, 0, -1),
        (t, 0, 1),
        (-t, 0, -1),
        (-t, 0, 1),
    ]
    faces = [
        (0, 11, 5),
        (0, 5, 1),
        (0, 1, 7),
        (0, 7, 10),
        (0, 10, 11),
        (1, 5, 9),
        (5, 11, 4),
        (11, 10, 2),
        (10, 7, 6),
        (7, 1, 8),
        (3, 9, 4),
        (3, 4, 2),
        (3, 2, 6),
        (3, 6, 8),
        (3, 8, 9),
        (4, 9, 5),
        (2, 4, 11),
        (6, 2, 10),
        (8, 6, 7),
        (9, 8, 1),
    ]
    for _ in range(level):
        midpoints: dict[tuple[int, int], int] = {}

        def mid(i: int, j: int, seen: dict[tuple[int, int], int] = midpoints) -> int:
            key = (min(i, j), max(i, j))
            if key not in seen:
                a, b = verts[i], verts[j]
                verts.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2))
                seen[key] = len(verts) - 1
            return seen[key]

        split = []
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            split += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = split
    points = np.array(verts, dtype=np.float64)
    points /= np.linalg.norm(points, axis=1, keepdims=True)
    return points, np.array(faces, dtype=np.int64)


def blob(rng: random.Random, level: int = 1, lump: float = 0.18) -> Mesh:
    """Unit sphere with every vertex pushed in or out, randomly turned: a crown, a puff, a rock."""
    verts, faces = _icosphere(level)
    push = np.array([1 + lump * rng.uniform(-1, 1) for _ in verts])
    mesh = Mesh.of((verts * push[:, None])[faces])
    return mesh.turn("y", rng.uniform(0, 360)).turn("x", rng.uniform(0, 360))
