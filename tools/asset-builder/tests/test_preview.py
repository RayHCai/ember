import struct
import zlib
from pathlib import Path

import numpy as np
from ember_asset_builder.gltf import Material, Model, Node
from ember_asset_builder.mesh import box
from ember_asset_builder.preview import View, render, sheet, write_png


def cube(colour: int) -> Model:
    root = Node("cube")
    root.add("paint", box(1, 1, 1))
    return Model(root, {"paint": Material(colour)})


def test_render_shows_the_model_on_the_background() -> None:
    image = render(cube(0xFF0000), 48, View(), ground=False)
    assert image.shape == (48, 48, 3)
    corner, middle = image[0, 0], image[24, 24]
    assert corner.min() > 200
    assert middle[0] > 2 * int(middle[1])


def test_ground_puts_a_disc_under_the_model() -> None:
    bare = render(cube(0xFF0000), 48, View(), ground=False)
    grounded = render(cube(0xFF0000), 48, View(), ground=True)
    assert not np.array_equal(bare, grounded)
    assert grounded[0, 0].tolist() == bare[0, 0].tolist()


def test_sheet_and_png_round_trip(tmp_path: Path) -> None:
    tile = render(cube(0x00FF00), 16, View(), ground=False)
    image = sheet([[tile, tile], [tile]], gap=2)
    assert image.shape == (38, 38, 3)
    path = tmp_path / "sheet.png"
    write_png(path, image)
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == (38, 38)
    length = struct.unpack(">I", data[33:37])[0]
    assert len(zlib.decompress(data[41 : 41 + length])) == 38 * (1 + 38 * 3)
