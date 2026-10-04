# 0011: Fire segmentation model and evidence fusion

**Status:** in-progress
**Touches:** tools/fire-seg, services/drone-runtime, packages/contracts

## Goal

Drones find fire from RGB as well as thermal. A lightly trained YOLO11n-seg model segments flame,
smoke and burned ground. Detections are reported as real region outlines. A detection's confidence
is evidence accumulated per grid cell across frames and drones, so one noisy frame cannot report a
fire at 98 %.

## Plan

- [x] `tools/fire-seg`: stage sources (Roboflow YOLO-seg exports, D-Fire boxes through SAM 2, FLAME
      image/mask pairs, Demo Data truth frames), assemble one Ultralytics dataset with a held-out
      test set, train, export ONNX with a model card, evaluate mask IoU through the runtime's
      detector
- [x] `fire-seg smoke`: whole pipeline on procedural images, 1 epoch on CPU
- [x] drone-runtime `perception/outline.py`: mask to short polygon (crack tracing + Douglas-Peucker)
- [x] `perception/yolo.py`: decode seg models exactly as Ultralytics 8.4 `process_mask` does;
      confidence = class score x mean mask probability; detection models still work
- [x] `perception/heuristic.py`: 520 K flame line, contrast with the local thermal background,
      area-aware confidence, outlines from the thermal blob
- [x] `perception/georef.py`: project the outline when there is one
- [x] `mapping/evidence.py`: per-cell log-odds for `on_fire` and `at_risk`; only confirmed
      detections are reported, with the cell posterior as confidence
- [x] Evidence shared across drones in `swarm` coverage payloads (`evidence`, optional)
- [x] Contracts: `RiskDetection` docs (droneInfo.ts), `SwarmCoverage.evidence` (droneLink.ts),
      mirrored in `link/messages.py`
- [x] Download D-Fire and a Roboflow set; stage, assemble, train on the Mac Mini (Ray): fire-seg-v1,
      5 of 50 epochs, committed under `data/fire-seg/models/`
- [x] drone-runtime runs fire-seg-v1 by default: onnxruntime is a core dependency, `--detector auto`
      finds the checkout's model, compose mounts it into drone-fleet
- [ ] Time fire-seg-v1 on a Pi 5 against 2 Hz
- [ ] Train longer (FLAME for the test split if it becomes available)
- [ ] Tune `EvidenceParams` against Demo Data runs once a trained model exists
- [ ] Optional: add a smoke label to Demo Data so its plumes stop counting as background

## Decisions

- Outlines are traced in the detector (pixel corners, 8-connected, largest component), not in
  georef, so the heuristic gets real thermal shapes too and georef only projects points.
- Mask decoding mirrors Ultralytics' `process_mask(upsample=True)` (upsample logits, then crop to
  the box at input resolution), so the drone sees the masks training measured. Checked against
  Ultralytics on 198 random masks: identical.
- Persistence lives in the world-frame evidence grid, not in image space: the drone moves 4 m
  between frames, so image-space persistence would need registration the grid gives for free.
- Evidence is linear in detector confidence (`gain * confidence`), not `logit(confidence)`: a
  detector's 0.3 is weak support, not evidence against. The floor is the prior, so a strong fresh
  detection confirms in one frame however long the cell looked clear; fires ignite.
- Drones share only their own evidence deltas, never relayed ones, so nothing is counted twice.
  edge-connector relays the payload opaquely, so Go needs no change.
- FusedDetector still merges same-risk overlaps within a frame (noisy-OR) so the wire carries one
  region per fire; the grid does the cross-frame part.
- fire-seg evaluates through `ember-drone-runtime`'s own `YoloDetector` (a workspace dependency)
  so the score is for exactly what ships, including letterbox and mask decoding.
- The released model is committed (`data/fire-seg/models/*.onnx`, 11 MB) so every checkout, Pi
  and compose stack runs YOLO with no setup. onnxruntime is a core drone-runtime dependency for the
  same reason; it has wheels for aarch64.
- Training dependencies (ultralytics, torch) are the `train` extra, which neither CI nor a plain
  `uv sync` installs. `opencv-python` is overridden away in favour of the headless build Demo Data
  already uses, so both never land in one environment.
- Demo Data's labels are 10 m fire-model cells, wider than the flames it draws. Flame labels are
  on-fire pixels that are also above 600 K in thermal (drawn flame); undrawn on-fire ground is
  burned; night frames label flame only. Sampling stops at 20:00, since later frames are black.
- Demo Data has no smoke label, so its frames stay at most 30 % of the training set. Its imagery is
  Maxar CC BY-NC 4.0, so a model trained on it is non-commercial too. Ultralytics is AGPL-3.0.

## Log

- 2026-10-03: Implemented everything above except training. Verified:
    - The full gate passes.
    - `fire-seg smoke` runs end to end (train, export, model card, evaluate).
    - A COCO yolo11n-seg export through `YoloDetector` matches Ultralytics' predictor: same
      detections, boxes within 5 px, mask IoU 0.91-0.94; the gap is outline simplification.
    - `stage-demo-data` works against a live Demo Data, and the label overlays look right.

    Next: on the Mac, `uv sync --package ember-fire-seg --extra train`, then `fire-seg smoke`, stage
    sources, assemble and train (tools/fire-seg/README.md).

- 2026-10-04: fire-seg-v1 trained (flame mask IoU 0.688 vs the colour baseline's 0.509, smoke
  0.781) and made the default detector. On 14 live Demo Data frames it found flame in every frame
  the RGB baseline did except one oblique shot, and nothing in fire-free frames; 77 ms a frame on a
  Windows laptop CPU. It reported no smoke on Demo Data's hazy frames.
