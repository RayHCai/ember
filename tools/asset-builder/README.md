# @ember/asset-builder

Generates the low-poly 3D models in `assets/` from code. There are no source files from a modelling
tool: a model is a Python function, so changing one is a code change that can be reviewed.

`assets/README.md` describes the output and how a consumer uses it.

## Run

From the repository root:

```bash
uv run asset-builder
```

| Flag            | Default  | Meaning                          |
| --------------- | -------- | -------------------------------- |
| `--out`         | `assets` | Directory to write into          |
| `--no-previews` | off      | Skip the preview sheets (faster) |

It writes every model as `.glb`, `manifest.json`, and `previews/*.png`. The output is deterministic
(seeded), so a rebuild with no code change leaves the files as they were. Commit the rebuilt
`assets/` together with the code change that produced it.

## Layout

```
src/ember_asset_builder/
  mesh.py        triangle meshes and primitives (loft, tube, lathe, strut, clump), per-face tints
  gltf.py        model = node tree of single-material meshes; .glb encoding
  drone.py       quadcopter
  trees.py       broadleaf, conifer, palm, umbrella, shrub; each at three levels of detail
  parts.py       what buildings are assembled from: walls, windows, doors, roof gear, a car
  houses.py      a house built to a footprint (gable or hip, lanai, carport, one or two storeys)
  commercial.py  a flat-roofed block built to a footprint (store, shop, office, lodge, hall)
  ruins.py       the ruin a footprint leaves
  fx.py          flames, smoke
  terrain.py     the ground square
  catalog.py     which models are written to which path, and what the preview sheets show
  preview.py     software renderer for the preview sheets
  cli.py         asset-builder
```

## Changing or adding a model

1. Edit the model function, or add one and register it in `catalog.py`. Buildings are parametric:
   another footprint is one more `House(...)` or `Block(...)` line in `catalog.py`, and the sim
   picks it up by its size without a code change there.
2. `uv run asset-builder`, then look at `assets/previews/`. The renderer culls back faces, so a
   face wound the wrong way shows as a hole.
3. Keep faces wound counter-clockwise seen from outside (`loft`, `tube` and `face` do this), and
   keep tints at or below 1: they multiply the material colour, so the material is the brightest
   tone.

Checks: `pnpm run test --filter @ember/asset-builder` (also `lint`, `format:check`, `typecheck`).
