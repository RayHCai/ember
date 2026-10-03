# 0004: Drone runtime core

**Status:** in-progress
**Touches:** services/drone-runtime, packages/contracts, internal/edgeproto, docs/architecture.md

## Goal

One `drone-runtime` process flies one drone. On `start_mapping` from its edge-connector it takes off,
maps everything inside the edge server's connectivity radius together with the other drones of the
run, runs risk detection on every camera frame and reports telemetry and georeferenced detections
up. Nothing in the core knows about Demo Data: flight, camera and detector are protocols, and the
Demo Data stream is one camera adapter among others.

## Plan

- [x] Edge link contract (`packages/contracts/src/droneLink.ts`, `internal/edgeproto/drone.go`,
      `ember_drone_runtime/link/messages.py`): hello, start/stop mapping, swarm relay, mission status
- [x] Geometry: local ENU frame around the edge server, pinhole camera rays, ray/plane hits
- [x] Mission grid: coverage, 2.5D height map (ground and surface top), risk per cell; deltas
      shared with the swarm by cell index
- [x] Perception: `Detector` protocol, thermal + colour baseline, ONNX YOLO (optional extra), fused
      detector, georeferencing boxes to ground outlines (depth when present, terrain otherwise)
- [x] Swarm: peer table with constant-velocity prediction, goal tiles assigned by the Hungarian
      algorithm over the whole swarm, altitude bands per drone
- [x] Navigation: geofence inside the connectivity radius, A* over the height map when the straight
      line is blocked, peer avoidance by closest-approach prediction
- [x] Mission brain (takeoff, mapping, returning, landing) with battery, link-loss and geofence
      failsafes
- [x] Adapters: simulated flight, Demo Data sensor stream camera, synthetic 3D world camera
- [x] Async runtime, edge WS client, in-process hub, `drone-runtime run` and `swarm-sim` CLI
- [ ] edge-connector: serve `/v1/drone` per `droneLink.ts` (pairing store, start/stop fan-out, relay
      `swarm` to the other drones of the run, telemetry and detections up to edge-manager)
- [ ] YOLO weights: train fire/smoke (e.g. D-Fire, plus Demo Data `truth=true` labels) and export to
      ONNX; the runtime loads them from `EMBER_YOLO_MODEL`
- [ ] Physical adapters: MAVLink flight controller, Pi camera, LiDAR depth
- [ ] Run `swarm-sim` against a live Demo Data server on the demo laptop

## Decisions

- Swarm messages go through edge-connector, which relays each one to the other drones of the run.
  A drone outside the connectivity radius is out of the mission anyway, so a star over the edge's
  network loses nothing, and it keeps the one channel `docs/architecture.md` allows. Rejected: a
  drone-to-drone mesh (second network stack, a second channel to secure).
- No leader. Every drone runs the same deterministic Hungarian assignment over the shared state
  (peer positions, current goals, merged coverage) and flies its own row. Current goals get a
  discount so assignments do not flap while coverage messages are in flight.
- Swarm positions and coverage cells are in the mission frame (metres east/north/up of the edge
  server), so drones never convert each other's lat/lng. The grid is fully defined by the mission
  (`connectivityRadiusM`, `cellSizeM`), so a cell index means the same cell on every drone.
- The core is synchronous and pure (`MissionBrain`); the async shell (`DroneRuntime`) only moves
  data between devices, link and brain. The swarm test runs brains in lockstep with no event loop.
- Depth when the frame has it, terrain otherwise. With LiDAR every pixel becomes a 3D point and
  feeds ground (min) and surface top (max) per cell. Without it (Demo Data) rays hit the ground
  estimate, so coverage still works and heights stay unknown.
- YOLO runs through ONNX Runtime (installable on a Raspberry Pi), not torch/ultralytics.
  `onnxruntime` is the optional `yolo` extra; without a model the baseline detector runs alone.
- "Prediction" on the drone is peer motion for avoidance and assignment. Fire spread prediction
  stays in the planner.

## Log

- 2026-10-03: Item opened; protocol, core and adapters written in one pass.
    - Checks: drone-runtime 51 tests (ruff, mypy strict clean); contracts typecheck. Go mirror
      (`internal/edgeproto/drone_test.go`) not run here: no Go toolchain on this machine.
    - Lockstep, synthetic world with depth:
        - 3 drones, 300 m radius: 98 % mapped in 265 s, all landed with about 80 % battery.
          Closest pair 10.4 m, vertical gaps counted double. Furthest from the edge 261 m (fence
          270 m).
        - 6 drones, 450 m radius: 98 % mapped in 296 s.
    - Fire boxes land on the fires: median 3 m inside the fire edge, worst 3.5 m outside.
    - At-risk boxes (the warm ring) land a median 11 m out. A few small boxes at the frame edge
      land 30 to 55 m off, because the box mixes occluding treetops with the warm ground. Boxes
      cannot fix this; a mask-producing model (YOLO-seg) would.
    - Treetops were first taken as ground, which put fire boxes up to 27 m off. Ground is now the
      lowest return within 5 cells.
    - Async `swarm-sim`, 3 drones at 10x: lands. Its separation figure comes from 0.5 s telemetry
      samples, so trust the lockstep one.
    - Not checked: `--camera sensor-stream` against a live Demo Data server (only a fake stream in
      `tests/test_io.py`).
    - Next: edge-connector `/v1/drone`. The runtime defaults to `ws://localhost:8070/v1/drone`;
      change the default if the connector picks another port.
