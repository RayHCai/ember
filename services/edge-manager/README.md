# @ember/edge-manager

The edge plane's one link to the API. It keeps a live registry of the edge connectors that have
registered with it and fans the API's start and stop tasks out to them. Each connector streams it
one aggregated update; it forwards what is new in each to drone-info and records edge servers,
drones, runs and detections at the API.

## Contract

All shapes are in `packages/contracts/src/edge.ts`, mirrored in `internal/edgeproto`.

| Route                      | Caller         | Does                                                                                                                                                                                                                                                            |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/tasks`           | api            | Takes an `EdgeTask` and sends each edge server it names a `ConnectorTask` at `<url>/v1/tasks`, all at once with a 10 s timeout each. Answers `EdgeTaskResult`: one result per edge server, so one failing does not fail the rest. 400 when the task is invalid. |
| `GET /v1/edge-servers`     | api            | `EdgeServerStatus[]`: every connector registered since this process started, online while its uplink is open, with its drone counts and run.                                                                                                                    |
| `GET /v1/edge` (WebSocket) | edge-connector | `register` → `registered`, then `EdgeUpdate`s. A second socket for the same id replaces the first.                                                                                                                                                              |
| `GET /healthz`             | anyone         | Liveness.                                                                                                                                                                                                                                                       |

Every route except `/healthz` needs `Authorization: Bearer $EMBER_EDGE_KEY`.

- A start task carries each edge server's location and connectivity radius, plus the zone
  boundary, cell size and altitude band.
- edge-manager turns the task into one mission per edge server. The connector adds the swarm.
- A task for an edge server that is not registered is still sent to the URL given, and the miss is
  logged.

## Forwarding to drone-info

Each update becomes one `DroneInfoIngest` posted to drone-info's `/v1/ingest`. drone-info counts
every message as a sign of life, so the batch holds only what drone-info does not already have:

- a connected drone's `hello`: the first time, then every 30 s, so a restarted drone-info learns
  names again;
- a drone's telemetry, only when it changed;
- every detections frame (the connector already sent each one once).

A post is tried 3 times. Updates queue in arrival order (256 deep), and beyond that they are
dropped. Failures and drops are logged at most once per 30 s.

Run state and newly mapped cells do not go to drone-info, whose ingest takes only `hello`,
`telemetry` and `detections`; the API gets them (below). A drone's mission status goes nowhere: the
run's coverage carries what it adds.

## Recording at the API

Each update is merged into pending state per edge server, never queued whole, and one worker sends
what is pending. A slow API costs a connector's uplink nothing and loses no change. Every request
carries `Authorization: Bearer $EMBER_EDGE_KEY`.

| What        | Sent when                                                                              | Request                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge server | a connector registers                                                                  | `PUT /v1/edge-servers/:edgeServerId` with its `url`                                                                                                  |
| Drone       | its `hello` name or kind is new or changed, or it first appears under this edge server | `PUT /v1/drones/:droneId` with `edgeServerId`, `name`, `kind`                                                                                        |
| Run         | cells are pending, or its state or coverage changed since the last accepted send       | `PUT /v1/mapping-runs/:runId/edge-servers/:edgeServerId` with the connector's `EdgeRun`, whose `newCells` is every cell the API has not yet accepted |
| Detections  | frames are pending                                                                     | `POST /v1/detections` with `edgeServerId`, at most 500 frames per request                                                                            |

- An edge server's drones and detections wait until its registration is accepted.
- A network error or a 5xx keeps the work pending. The pass is tried again after 1 s, then 2 s and so
  on up to 30 s, and the delay resets after a clean pass. Pending cells are cleared only when their
  `PUT` succeeds.
- A 409 on a drone means the API does not know the edge server yet: the registration is sent again,
  then the drone.
- Any other 4xx is permanent. The item is logged and dropped, not retried. A refused run (its `zoneId`
  is not a uuid, say, because it was started by hand) is ignored until the connector reports another.
- At most 2000 frames wait per edge server. Beyond that the oldest are dropped and the drops logged.
- A failure is logged at most once per 30 s per kind of item, with how many it held back.

## Run

```bash
go run ./services/edge-manager/cmd            # from the repo root
```

| Variable                  | Default                 | Meaning                                                                                                                |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `EMBER_EDGE_MANAGER_ADDR` | `:8060`                 | Listen address                                                                                                         |
| `EMBER_DRONE_INFO_URL`    | `http://localhost:4002` | drone-info; empty disables forwarding                                                                                  |
| `EMBER_API_URL`           | `http://localhost:4001` | api; empty disables recording                                                                                          |
| `EMBER_EDGE_KEY`          | unset                   | Shared bearer key, required of callers and sent to the API. Unset accepts anything and logs a warning (local dev only) |

Start a run by hand (ids and URLs from `GET /v1/edge-servers`):

```bash
curl -X POST localhost:8060/v1/tasks -H 'Authorization: Bearer dev' -d '{
  "kind": "start_mapping", "runId": "run-1", "zoneId": "zone-1", "boundary": null,
  "cellSizeM": 10, "altitude": { "minM": 60, "maxM": 120 },
  "edgeServers": [{ "edgeServerId": "edge-...", "url": "http://192.168.1.20:8070",
                    "location": { "lat": 20.8838, "lng": -156.667 }, "connectivityRadiusM": 300 }]
}'
```
