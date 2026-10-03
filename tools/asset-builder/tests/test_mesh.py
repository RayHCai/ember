import random

import numpy as np
import pytest
from ember_asset_builder.mesh import Mesh, blob, box, cylinder, face, linear, ring, slab, tube


def volume(mesh: Mesh) -> float:
    """Signed volume: positive only when a closed mesh's faces all wind outwards."""
    a, b, c = mesh.tris[:, 0], mesh.tris[:, 1], mesh.tris[:, 2]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)


def test_box_is_closed_and_faces_outwards() -> None:
    assert volume(box(2, 3, 4)) == pytest.approx(24)


def test_bevelled_box_loses_only_its_edges() -> None:
    assert 20 < volume(box(2, 3, 4, bevel=0.2)) < 24


def test_cylinder_tube_and_blob_face_outwards() -> None:
    assert volume(cylinder(8, 1, 2)) > 0
    assert volume(tube([(0, 0, 0), (1, 2, 0), (3, 3, 1)], 0.3, 6, bottom=True, top=True)) > 0
    assert volume(blob(random.Random(1))) > 0


def test_mirroring_keeps_faces_outwards() -> None:
    assert volume(box(1, 1, 1).scale(1, 1, -1)) == pytest.approx(1)


def test_face_winds_towards_the_asked_side() -> None:
    square = ring(4, 1)
    assert face(square, (0, 1, 0)).normals()[:, 1] == pytest.approx(1)
    assert face(square, (0, -1, 0)).normals()[:, 1] == pytest.approx(-1)


def test_slab_top_faces_up_and_the_rest_closes_it() -> None:
    top, rest = slab(ring(4, 1, 1.0), 0.5)
    assert top.normals()[:, 1] == pytest.approx(1)
    assert volume(Mesh.join([top, rest])) == pytest.approx(1.0)


def test_collapsed_triangles_are_dropped() -> None:
    flat = box(1, 1, 1).warp(lambda p: p * np.array([1.0, 0.0, 1.0]))
    assert np.isfinite(flat.normals()).all()


def test_tints_multiply() -> None:
    mesh = box(1, 1, 1).shade(0.5).shade((1.0, 0.5, 0.0))
    assert mesh.tint[0] == pytest.approx([0.5, 0.25, 0.0])


def test_linear_converts_from_srgb() -> None:
    assert linear(0xFFFFFF) == pytest.approx((1, 1, 1))
    assert linear(0x808080)[0] == pytest.approx(0.2159, abs=1e-3)
