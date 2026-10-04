# @ember/contracts

The TypeScript side of every cross-service shape. Go mirrors the edge shapes in
`internal/edgeproto`; Python mirrors the planner shapes in `services/planner` (`wire.py`).

- `api.ts`: the api's records and routes, and how callers authenticate.
- `planner.ts`: the planner plane (Redis queue, Celery task) and the api routes the planner calls.
- `edge.ts`: api -> edge-manager -> edge-connectors: tasks, the connector uplink, the live registry.
- `droneLink.ts`: the WebSocket between a drone-runtime and its edge-connector.
- `droneInfo.ts`: drone-info's live stream to viewers (fleet, telemetry, detections), the
  `follow` and `watch` requests, and the ingest edge-manager posts. Drones report the same
  `telemetry` and `detections` shapes.
- `agent.ts`: operator-agent's chat route.
- `civilian.ts`, `common.ts`: shared records and ids.
