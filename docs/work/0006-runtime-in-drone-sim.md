# 0006: Drone runtime in the drone sim

**Status:** in-progress
**Touches:** services/drone-info, services/drone-runtime, services/demo-data, packages/contracts,
internal/edgeproto, apps/sim, docs/architecture.md

## Goal

The drone sim shows a drone-runtime drone flying its mapping run over Lahaina and boxing the fires
its detector finds, live, with Demo Data's clock running at a speed set on its command line.

## Plan

- [x] Ingest contract: `DRONE_INFO_INGEST_PATH`, `DroneInfoIngest` in `droneInfo.ts`, mirrored in
      `internal/edgeproto` and drone-runtime
- [x] `services/drone-info`: `POST /v1/ingest` (hello, telemetry, detections) and `WS /v1/stream`
      per `droneInfo.ts` (fleet on connect and every second, followed drone's telemetry and
      detections)
- [x] drone-runtime `swarm-sim --drone-info URL`: its in-process edge posts what drones report to
      drone-info's ingest route
- [x] `demo-data serve --speed --start`
- [x] End to end: Demo Data, drone-info, swarm-sim, sim in a browser
- [ ] Run the sim on the real edge path once 0005 (edge-manager and edge-connector) lands: its
      edge-manager already posts `DroneInfoIngest` to drone-info's `/v1/ingest`, so drone-info
      needs no change; check it end to end, then drop `swarm-sim --drone-info`

## Decisions

- drone-info is fed over HTTP (`POST /v1/ingest`), the edge-manager -> drone-info channel in
  `docs/architecture.md`. Until edge-connector and edge-manager exist, `swarm-sim`'s in-process
  edge posts there in their place, the same way the sim's dummy feed stood in for drone-info.
  Rejected: drone-runtime talking to drone-info directly from `DroneRuntime` (a new channel that
  would outlive the stand-in).
- drone-info learns a drone's name and kind from the `hello` the edge forwards. A drone it has
  only telemetry for is listed under its id.
- With `--drone-info`, `swarm-sim` defaults to the sensor-stream camera, because the sim draws
  Demo Data's world: boxes from the synthetic world would land on fires the sim does not have.

## Log

- 2026-10-03: Item opened and the plan above implemented.
    - Checks: drone-info 3 tests (ingest validation; stream fleet, follow, live updates via
      `injectWS`); drone-runtime 52 (adds the forwarder against a real HTTP server); Demo Data
      `tests/test_cli.py` 4. Go mirror of the ingest shapes not run here (no Go toolchain).
    - End to end on this laptop, all on localhost:
        - Demo Data `--speed 30`, drone-info, `swarm-sim --drone-info` with 3 drones over a
          250 m radius at the default centre.
        - Every run mapped 98-99.6 % and landed in 3 min. Closest pair 18.8-19.6 m.
        - drone-info sent the fleet each second and the followed drone's telemetry at 2 Hz.
    - The sim in headless Chrome (`?drone=sim-1&droneInfo=localhost:4002`) showed sim-1 flying
      its run over the burning town. Its frustum and footprint followed it, at-risk and fire boxes
      sat on the fire, and the drone came down at the end.
    - Found and fixed on the way:
        - Each new connection to an IPv4-only drone-info waited 2 s, because Windows tries `::1`
          first for `localhost`. Telemetry arrived in 2.3 s clumps. drone-info now listens on
          `::`; largest gap 0.67 s.
        - Drones took frames as fast as Demo Data rendered them (about 13 a second each).
          drone-runtime now takes at most 2 a second (`frame_period_s`); coverage is unchanged.
    - Not checked: the Tauri window (browser only), and the real edge path (0005, in progress in
      a parallel session; its edge-manager posts the same `DroneInfoIngest`).
