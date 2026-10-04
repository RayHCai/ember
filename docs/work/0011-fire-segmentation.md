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
      eval set, train, export ONNX with a model card, evaluate mask IoU through the runtime's detector
- [x] `tools/fire-seg smoke`: whole pipeline on procedural images, 1 epoch on CPU
- [x] drone-runtime `perception/outline.py`: mask to short polygon (crack tracing + Douglas-Peucker)
- [x] `perception/yolo.py`: decode seg models (mask prototypes), confidence = class score x mean
      mask probability; detection models still work
- [x] `perception/heuristic.py`: 520 K flame line, contrast with the local thermal background,
      area-aware confidence, outlines from the thermal blob
- [x] `perception/georef.py`: project the outline when there is one
- [x] `mapping/evidence.py`: per-cell log-odds for `on_fire` and `at_risk`; only confirmed
      detections are reported, with the cell posterior as confidence
- [x] Evidence shared across drones in `swarm` coverage payloads (`evidence`, optional)
- [x] Contracts: `RiskDetection` docs (droneInfo.ts), `SwarmCoverage.evidence` (droneLink.ts),
      mirrored in `link/messages.py`
- [ ] Train on the Mac Mini (owner: Ray), copy the ONNX to the drone, set `EMBER_YOLO_MODEL`
- [ ] Time the exported model on a Pi 5 against the 2 Hz frame budget
- [ ] Tune `EvidenceParams` against Demo Data runs once a trained model exists

## Decisions

- Outlines are traced in the detector (pixel corners, 8-connected, largest component), not in
  georef, so the heuristic gets real thermal shapes too and georef only projects points.
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
- Training dependencies (ultralytics, torch) are the `train` extra; CI and `uv sync
--all-packages` never install them. `opencv-python` is overridden away in favour of the
  headless build Demo Data already uses, so both never land in one environment.
- Demo Data has no smoke label, so its frames carry flame and burned only and stay at most 30 % of
  the training set; its plumes are unlabelled. Demo Data imagery is Maxar CC BY-NC 4.0, so a model
  trained on it is non-commercial too. Ultralytics is AGPL-3.0.

## Log

- 2026-10-03: Implemented everything above except training. Next: run `fire-seg smoke` on the Mac,
  stage sources, assemble, train (see tools/fire-seg/README.md).
