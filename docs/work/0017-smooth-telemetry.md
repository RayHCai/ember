# 0017: Smooth telemetry

**Status:** done
**Touches:** services/drone-runtime, services/edge-connector, apps/drone-sim

## Goal

A drone followed in drone-sim moves at a steady speed: no holds and jumps between telemetry
messages, whatever the scenario speed or how fast the drone flies.

## Plan

- [x] Measure the stutter on the compose stack (record drone-info's stream, replay drone-sim's
      interpolation at 60 fps)
- [x] drone-runtime: telemetry at 10 Hz on a fixed schedule, pose read at send time so it matches
      `sentAt` (`runtime.py`)
- [x] edge-connector: `EMBER_EDGE_UPDATE_MS` default 50, drone health saved to SQLite at most once a
      second instead of every tick (`cmd/main.go`, `connector/aggregate.go`)
- [x] drone-sim: interpolate on the drone's `sentAt` timeline, offset by the smallest observed
      latency, ~300 ms behind; carry on along the reported velocity for up to 1 s when a message is late
      (`src/droneInfo/track.ts`)
- [x] drone-runtime: close the sensor-stream socket when a capture fails, so Demo Data stops
      rendering for abandoned connections (`sensors/sensor_stream.py`)
- [x] Re-measure with the same recording script; expect ~0% frozen frames and speed near truth

## Decisions

- Interpolate on `sentAt`, not arrival time: arrival spacing carries every hop's jitter (the
  connector's tick alone adds 0-500 ms at the old rate); `sentAt` spacing is the drone's own. The
  clock offset between drone and viewer is the smallest `arrival - sentAt` seen, so skew cancels.
- Connector ticks at twice the drone's telemetry rate so its latest-wins snapshot never overwrites
  a sample. Rejected: sending every sample in the update (a wire change in TS, Go and Python for a
  viewer concern); forwarding telemetry outside the tick (a second path to edge-manager).
- Health stays in SQLite at 1 Hz: it is a last-known record, and a commit per 50 ms tick would sit
  in front of every send.

## Log

- 2026-10-04: Measured on compose (3 drones, 60 s). Drone sends 2 Hz, connector samples latest at
  2 Hz on its own clock: 12 of 335 samples overwritten (1003 ms gaps), latency 150 ms to >1 s.
  drone-sim holds 150 ms behind arrival time, tuned for its 10 Hz dummy: frozen in 70% of frames,
  jumps to 500-900 m/s. Also found Demo Data at ~300% CPU with 33 leaked `/v1/stream` sockets
  (34 opened, 0 closed): the runtime drops a timed-out socket without closing it.
- 2026-10-04: Implemented all four with tests (runtime schedule and fresh pose, connector health
  throttle, sensor socket closed on timeout, drone-sim `sentAt` track); package gates pass, Go
  tests run in `golang:1.24` (no host toolchain). Replaying the old 2 Hz recording through the new
  track alone: frozen frames 70% -> ~20%, speed p95 15-18 -> 8.2-8.4 m/s. Next: record the rebuilt
  stack at 10 Hz during a scan and replay (scratch scripts: record drone-info's stream with
  `watch`, replay `poseAt` causally at 60 fps).
- 2026-10-04: Re-measured the rebuilt stack during a scan (real-1, sim-1, sim-2; 60 s, ~9 Hz each
  at drone-info). Latency spread p95 ~1 s -> 60-110 ms. Replayed through the new track: speed p95
  8.1-8.6 m/s against a true 8; frozen frames 6-10%, all but 0.3% while the drone itself reported
  under 1 m/s (hovering at goals). The 0.3% came from one 3.4 s outage on every drone at once, as
  were a few 0.5-0.7 s gaps; a 45 s window measured at both edge-manager (`lastSeen`, 50 ms p50,
  186 ms max) and drone-info was clean, so they are intermittent host stalls (images were being
  rebuilt then), not a hop. Raised the extrapolation cap 0.5 s -> 1 s: false freezes 0%, worst
  spike 104 -> 32 m/s. Dashboard extrapolate-then-snap left as is (not in scope).
