"""Software renders of the models, so a change to them can be reviewed as a picture."""

from __future__ import annotations

import math
import struct
import zlib
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from .gltf import Model
from .mesh import Array, linear, ring

Image = NDArray[np.uint8]

_SUPERSAMPLE = 3
_SUN = np.array([0.42, 0.8, 0.43]) / np.linalg.norm([0.42, 0.8, 0.43])
_SUN_COLOR = np.array([1.0, 0.96, 0.88]) * 0.8
_SKY = np.array([0.36, 0.4, 0.47])
_EARTH = np.array([0.2, 0.19, 0.18])
_BACKGROUND = np.array(linear(0xE4E9ED))
_GROUND = np.array(linear(0xC9D1D8))
_SHADOW = 0.7


@dataclass(frozen=True)
class View:
    """Where the camera orbits to: `yaw` degrees round from the front (+Z), `pitch` degrees up."""

    yaw: float = 35.0
    pitch: float = 24.0


def _srgb(colour: Array) -> Image:
    c = np.clip(colour, 0, 1)
    encoded = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    return (encoded * 255 + 0.5).astype(np.uint8)


def _covered(
    xy: Array, depth: Array, size: int
) -> Iterator[tuple[int, slice, slice, NDArray[np.bool_], Array]]:
    """Per triangle: the pixel block it touches, the pixels it covers there, its depth at each."""
    for i, ((ax, ay), (bx, by), (cx, cy)) in enumerate(xy):
        x0, x1 = max(math.floor(min(ax, bx, cx)), 0), min(math.ceil(max(ax, bx, cx)), size - 1)
        y0, y1 = max(math.floor(min(ay, by, cy)), 0), min(math.ceil(max(ay, by, cy)), size - 1)
        area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if x0 > x1 or y0 > y1 or abs(area) < 1e-9:
            continue
        px, py = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area
        w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if inside.any():
            z = w0 * depth[i, 0] + w1 * depth[i, 1] + w2 * depth[i, 2]
            yield i, slice(y0, y1 + 1), slice(x0, x1 + 1), inside, z


def render(model: Model, size: int, view: View, *, ground: bool = True) -> Image:
    """Orthographic render of `model`, `size` pixels square, lit by a sun and a sky."""
    yaw, pitch = math.radians(view.yaw), math.radians(view.pitch)
    towards = np.array(
        [math.sin(yaw) * math.cos(pitch), math.sin(pitch), math.cos(yaw) * math.cos(pitch)]
    )
    right = np.cross([0.0, 1.0, 0.0], towards)
    right /= np.linalg.norm(right)
    up = np.cross(towards, right)

    tris: list[Array] = []
    albedo: list[Array] = []
    alpha: list[Array] = []
    for name, mesh in model.root.walk():
        material = model.materials[name]
        normals = mesh.normals()
        facing = normals @ towards > 0
        keep = facing | material.double_sided
        normals = np.where(facing[:, None], normals, -normals)[keep]
        n = int(keep.sum())
        sun = np.clip(normals @ _SUN, 0, None)[:, None] * _SUN_COLOR
        sky = _EARTH + (_SKY - _EARTH) * ((normals[:, 1:2] + 1) / 2)
        base = np.array(linear(material.color)) * mesh.tint[keep]
        emissive = np.array(linear(material.emissive)) if material.emissive is not None else 0.0
        tris.append(mesh.tris[keep])
        albedo.append(base if material.unlit else base * (sun + sky) + emissive)
        alpha.append(np.full(n, material.alpha))
    points = np.concatenate(tris)
    colour = np.concatenate(albedo)
    opacity = np.concatenate(alpha)

    low = points.reshape(-1, 3).min(axis=0)
    high = points.reshape(-1, 3).max(axis=0)
    floor = float(low[1])
    disc = ring(
        48,
        0.7 * float(max(high[0] - low[0], high[2] - low[2])) + 0.1 * float(high[1] - low[1]),
        floor,
        at=(float(low[0] + high[0]) / 2, float(low[2] + high[2]) / 2),
    )
    framed = np.concatenate([points.reshape(-1, 3), disc]) if ground else points.reshape(-1, 3)
    sx, sy = framed @ right, framed @ up
    span = max(float(np.ptp(sx)), float(np.ptp(sy)))
    pixels = size * _SUPERSAMPLE
    zoom = 0.9 * pixels / span
    centre = np.array([(sx.min() + sx.max()) / 2, (sy.min() + sy.max()) / 2])

    def project(p: Array) -> tuple[Array, Array]:
        screen = np.stack([p @ right, p @ up], axis=-1) - centre
        return screen * np.array([zoom, -zoom]) + pixels / 2, p @ towards

    image = np.broadcast_to(_BACKGROUND, (pixels, pixels, 3)).copy()
    zbuf = np.full((pixels, pixels), -np.inf)

    def draw(xy: Array, depth: Array, colours: Array) -> None:
        for i, ys, xs, inside, z in _covered(xy, depth, pixels):
            hit = inside & (z > zbuf[ys, xs])
            zbuf[ys, xs][hit] = z[hit]
            image[ys, xs][hit] = colours[i]

    if ground:
        centre_point = np.broadcast_to(disc.mean(axis=0), disc.shape)
        fan = np.stack([centre_point, np.roll(disc, -1, axis=0), disc], axis=1)
        draw(*project(fan), np.broadcast_to(_GROUND, (len(fan), 3)))
        ground_depth = zbuf.copy()

    solid = opacity >= 1.0
    draw(*project(points[solid]), colour[solid])

    if ground:
        cast = points[solid] - _SUN * ((points[solid][..., 1:2] - floor) / _SUN[1])
        shadow = np.zeros((pixels, pixels), dtype=np.bool_)
        for _, ys, xs, inside, _ in _covered(*project(cast), pixels):
            shadow[ys, xs] |= inside
        # Only ground pixels still showing take the shadow: nothing in front of them was drawn.
        image[shadow & np.isfinite(ground_depth) & (zbuf == ground_depth)] *= _SHADOW

    sheer = ~solid
    xy, depth = project(points[sheer])
    order = np.argsort(depth.mean(axis=1))
    for i, ys, xs, inside, z in _covered(xy[order], depth[order], pixels):
        hit = inside & (z > zbuf[ys, xs])
        a = opacity[sheer][order][i]
        image[ys, xs][hit] = image[ys, xs][hit] * (1 - a) + colour[sheer][order][i] * a

    small = image.reshape(size, _SUPERSAMPLE, size, _SUPERSAMPLE, 3).mean(axis=(1, 3))
    return _srgb(small)


def sheet(rows: Sequence[Sequence[Image]], gap: int = 8) -> Image:
    """Tiles laid out in rows on the background colour; short rows are left-aligned."""
    tile = rows[0][0].shape[0]
    columns = max(len(row) for row in rows)
    height = len(rows) * tile + (len(rows) + 1) * gap
    width = columns * tile + (columns + 1) * gap
    out = np.broadcast_to(_srgb(_BACKGROUND), (height, width, 3)).copy()
    for r, row in enumerate(rows):
        for c, image in enumerate(row):
            y, x = gap + r * (tile + gap), gap + c * (tile + gap)
            out[y : y + tile, x : x + tile] = image
    return out


def write_png(path: Path, image: Image) -> None:
    height, width, _ = image.shape

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    rows = b"".join(b"\0" + image[y].tobytes() for y in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
