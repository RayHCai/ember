# @ember/contracts

The TypeScript side of every cross-service shape. Wire shapes shared with Go and Python are mirrored in `schemas/` as JSON Schema.

- `droneInfo.ts`: drone-info's live stream to viewers (fleet, telemetry, detections) and the
  `follow` request. Drones report the same `telemetry` and `detections` shapes.
