# @ember/drone-info

Live drone state for viewers. Edges post what their drones report; viewers (dashboard,
drone-sim) get the fleet and follow one drone, or watch several, over a WebSocket. It keeps only
the latest state per drone in memory: history and the registry of record live in `api`.

## Contract

Shapes are in `packages/contracts/src/droneInfo.ts`.

| Method | Path         | Who          | What                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/ingest` | edge-manager | `DroneInfoIngest`: `hello`, `telemetry` and `detections` messages, unchanged from the edge link. Answers `DroneInfoIngestResult`; bad messages are dropped and counted, never fail the batch.                                                                                                                         |
| WS     | `/v1/stream` | viewers      | `fleet` on connect and every second. After `{"type": "follow", "droneId": ...}`, that drone's latest `telemetry` and `detections`, then each new one as it arrives. `{"type": "watch", "droneIds": [...]}` does the same for a list of drones (the dashboard watches a zone's fleet); each `watch` replaces the last. |
| GET    | `/healthz`   | anyone       | Liveness                                                                                                                                                                                                                                                                                                              |

A drone appears in `fleet` once it has sent telemetry. Its name and kind come from its `hello`; a
drone with no `hello` is listed under its id as `physical`.

For testing without edge-manager, `drone-runtime swarm-sim --drone-info URL` posts to `/v1/ingest`
directly.

## Run

```bash
pnpm --filter @ember/drone-info build && node services/drone-info/dist/main.js   # port 4002
```

`PORT` overrides the port. It listens on both IPv4 and IPv6, because on Windows `localhost` tries
`::1` first, and an IPv4-only listener costs every new connection a 2 s fallback.
