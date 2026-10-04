# @ember/fire-seg

Builds the fire segmentation dataset and trains the drone's RGB model: YOLO11n-seg with three
classes, `flame`, `smoke` and `burned`. It then exports the model to ONNX and scores it the way the
drone runs it. drone-runtime loads `data/fire-seg/models/fire-seg-v1.onnx` by default, or the ONNX
at `EMBER_YOLO_MODEL`. Thermal stays the main flame signal; this model adds smoke, burned ground
and flames thermal misses.

Weights stay out of git (`*.onnx` and `*.pt` are ignored), except released exports in
`data/fire-seg/models/`, which drones load by default. Everything lives under the data root:
`data/fire-seg/` by default, or `EMBER_FIRE_SEG_DIR`, or `--root`.

## Pipeline

```
sources/<name>/      one staged dataset each: images/, labels/ (our classes), source.json
dataset/             assembled: images/{train,val,test}, labels/..., data.yaml, manifest.json
runs/<name>/         Ultralytics training runs (weights/best.pt, last.pt, plots)
models/<name>.onnx   the export the drone loads, plus <name>.json (model card) and <name>.eval.json
```

| Step | Command | Notes |
|---|---|---|
| Stage | `stage-yolo-seg`, `stage-yolo-det`, `stage-mask-pairs`, `stage-demo-data` | Class names are mapped by keyword (fire/flame, smoke, burned/burnt/char); other classes are dropped. Images left with no instances stay as background. |
| Assemble | `assemble` | Splits by hashed groups of images, so video frames never straddle splits. The test split takes only from real aerial sources. Synthetic sources (Demo Data) are capped at 30 % of train and val. `manifest.json` records counts, licences and a content hash (the dataset version). |
| Train | `train` | Fine-tunes `yolo11n-seg.pt` (COCO). It then exports ONNX (opset 17, no NMS in the graph, class names in metadata), writes the model card and evaluates on the test split. |
| Evaluate | `evaluate` | Runs the ONNX through drone-runtime's own `YoloDetector` and reports mask IoU, pixel and image-level precision and recall per class, and latency. It also scores the colour baseline on flame for comparison. |

## On the training machine (Mac Mini)

```bash
# once: uv (https://docs.astral.sh/uv), then from the repo root
uv sync --package ember-fire-seg --extra train
export PYTORCH_ENABLE_MPS_FALLBACK=1    # ops Apple's GPU lacks fall back to the CPU

# 1. prove the pipeline: procedural images, 1 epoch on CPU, export, evaluate (~1 min)
uv run --package ember-fire-seg fire-seg smoke

# 2. stage sources (download them first; see Sources)
uv run --package ember-fire-seg fire-seg stage-mask-pairs ~/data/FLAME/Images ~/data/FLAME/Masks \
    --name flame --aerial --group-block 50 --license "see IEEE DataPort"
uv run --package ember-fire-seg fire-seg stage-yolo-det ~/data/D-Fire --name dfire --names smoke,fire \
    --license "see D-Fire"
uv run --package ember-fire-seg fire-seg stage-yolo-seg ~/data/roboflow-fire --name rf-fire --license "CC BY 4.0"
uv run --package ember-fire-seg fire-seg stage-demo-data --url http://<demo-data-host>:8090 --count 600

# 3. assemble (test split from FLAME) and train; caffeinate keeps the Mac awake
uv run --package ember-fire-seg fire-seg assemble --test-sources flame
caffeinate -i uv run --package ember-fire-seg fire-seg train --name fire-seg-v1
```

`train` picks CUDA, then Apple's MPS, then CPU (`--device` overrides it). Defaults are 50 epochs,
416 px and batch 16, with early stopping after 20 epochs that don't improve. `--resume
data/fire-seg/runs/fire-seg-v1/weights/last.pt` continues a stopped run. Before trusting MPS, time
the first epoch and multiply out. If the loss goes NaN on MPS, rerun with `--device cpu` to compare.

To release a model, commit its `.onnx` and `.json` model card under `data/fire-seg/models/`; the
card says which commit, dataset version and scores produced it. drone-runtime picks up
`fire-seg-v1.onnx` from a checkout; to run another, set `EMBER_YOLO_MODEL` to its file.

To time the model on a Pi 5 against the drone's 2 Hz frame budget: `uv sync --package
ember-fire-seg --extra eval`, then `fire-seg evaluate <model.onnx> --split <images folder> --limit
50`. That needs no torch.

## Sources

None of these can be fetched without an account or a manual step, so you download them yourself
and stage the folder.

| Source | What it gives | Stage with |
|---|---|---|
| FLAME (IEEE DataPort, 2020) | Drone footage of pile burns with fire masks: the closest match to the drone's view. Use it for the test split. | `stage-mask-pairs IMAGES MASKS --aerial --group-block 50` (masks paired to images by file stem) |
| D-Fire (github.com/gaiasd/DFireDataset) | About 21k fire and smoke images, boxes only (YOLO format, 0 smoke, 1 fire) | `stage-yolo-det --names smoke,fire`: SAM 2 turns each box into a mask. A mask filling less than 10 % of its box falls back to the box, counted in `source.json` notes. Slow on CPU. |
| Roboflow Universe fire and smoke sets | Ready-made masks; quality and licences vary | Export as "YOLOv8"/"YOLO11" segmentation, then `stage-yolo-seg` |
| Demo Data (services/demo-data) | Unlimited flame and burned labels from the Lahaina sim, 15:00-20:00 | `stage-demo-data` against a running `demo-data serve`, about 2.5 s a frame. Flame is labelled where flame is actually drawn (on-fire cells that are hot in thermal), and night frames label flame only. It has no smoke label, so its drawn plumes count as background; that is one reason for the 30 % cap. |

## Licences

- Ultralytics is AGPL-3.0, and Ultralytics says models trained with it are too, unless you hold an
  enterprise licence.
- Demo Data renders over Maxar imagery (CC BY-NC 4.0), so a model trained on it is
  non-commercial.
- Check each downloaded dataset's terms and record them with `--license`. They end up in the
  manifest and in every model card.

## Development

The core (staging, assembly, evaluation) needs no torch and is what CI tests. Training code imports
Ultralytics lazily, and only from `train.py` and `stage-yolo-det`.
