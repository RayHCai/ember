# @ember/api

See [docs/architecture.md](../../docs/architecture.md) for what this service owns. Wire shapes are
in [`packages/contracts/src/api.ts`](../../packages/contracts/src/api.ts) (records),
[`planner.ts`](../../packages/contracts/src/planner.ts) (planner routes) and
[`edge.ts`](../../packages/contracts/src/edge.ts) (what the api sends edge-manager).

## Database

Prisma 7 against the shared Postgres in `compose.yaml`; `DATABASE_URL` comes from the root `.env`
(copy it next to this package or export it). The generated client in `src/generated/` is gitignored
and rebuilt by `build`, `typecheck` and `test`.

```
pnpm --filter @ember/api db:deploy    # apply migrations
pnpm --filter @ember/api db:migrate   # create a migration after editing prisma/schema.prisma
```

`db:migrate` (`prisma migrate dev`) offers to reset the database when it finds drift. Point it only
at a local database. Migrations for a shared database are additive: create tables, columns and
indexes, never drop.

| Table                    | Holds                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `civilians`              | Signed-up phones and ZIPs                                                                      |
| `operators`              | Operator email (lowercased, unique), name, scrypt password hash                                |
| `operator_sessions`      | SHA-256 of each session token, its operator and expiry                                         |
| `watch_zones`            | Name, region, boundary ring (JSONB `LatLng[]`), repeat-scan interval and next scan, creator    |
| `edge_servers`           | Connector token (id), URL, name, zone, ground position, connectivity radius                    |
| `edge_server_placements` | Planned edge server sites of a zone: name, position, connectivity radius                       |
| `drones`                 | Drone id, name, kind and the edge server it is assigned to                                     |
| `scans`                  | One mapping run of a zone: who asked, state, cell size, edge-manager's per-edge-server results |
| `mapping_runs`           | Per run and edge server: grid origin and cell size, state, coverage, mapped cell set           |
| `detection_frames`       | Each `DroneDetections` frame: drone, frame id, capture time, pose, camera, detector            |
| `detections`             | Each `RiskDetection` in a frame: risk class, confidence, `bboxPx`, ground outline              |
| `zone_surroundings`      | Per zone, from OpenStreetMap: civilian areas, roads, safe zones, stations, fetch status        |
| `planner_jobs`           | Job state, options, last message, the worker's `PlannerResult`                                 |
| `blasts`                 | Messages to a zone's civilians or responders, with the operator approval                       |

Deleting a watch zone deletes its placements, scans, mapping runs, surroundings, planner jobs and
blasts; its edge servers and detection frames stay, with no zone. Deleting an edge server leaves its
drones registered and unassigned. Deleting an operator deletes their sessions.

A check constraint (`blasts_civilians_need_approval`) refuses a `queued` blast to civilians without
an approval, so the human-in-the-loop rule holds even outside the api's code.

## Auth

`/healthz`, `POST /civilians`, sign-up and sign-in are open. Every other `/v1` route needs
`Authorization: Bearer <token>`, where the token is an operator's session, `EMBER_EDGE_KEY`,
`EMBER_PLANNER_KEY` or `EMBER_AGENT_KEY`. The planner's three routes take only `EMBER_PLANNER_KEY`,
and `GET /v1/civilians` (phone numbers) only `EMBER_AGENT_KEY`. An unset key is skipped; with no key
set every route is open and the api logs a warning (local dev only), but
a valid session token still identifies its operator.

Sign-up and sign-in answer an `OperatorSession`. The token is 32 random bytes (base64url); the api
stores only its SHA-256 and the session lasts `SESSION_DAYS` (7). Passwords are stored as
`scrypt$N$r$p$salt$hash` (N 16384, r 8, p 1, 64-byte key, 16-byte salt). A wrong password and an
unknown email get the same 401.

Browsers may call the api from `http(s)://localhost:*`, `http(s)://127.0.0.1:*`,
`tauri://localhost`, `http(s)://tauri.localhost` and the origins in `EMBER_API_ORIGINS`.

## Routes

Errors are `{ error }`. Lists take `limit` (1-1000, default 100). `:zoneId`, `:placementId` and
`:blastId` are uuids.

| Method             | Path                                                 | Body / query                                              | Result                                                         |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| GET                | `/healthz`                                           |                                                           | `{ service, ok }`                                              |
| POST               | `/civilians`                                         | `CreateCivilianRequest`                                   | 201 `Civilian`; 409 dup phone                                  |
| POST               | `/v1/auth/sign-up`                                   | `SignUpRequest`                                           | 201 `OperatorSession`; 409 email taken                         |
| POST               | `/v1/auth/sign-in`                                   | `SignInRequest`                                           | `OperatorSession`; 401                                         |
| GET, DELETE        | `/v1/auth/session`                                   | operator session                                          | `SessionInfo`; DELETE 204 signs out                            |
| POST               | `/v1/watch-zones`                                    | `CreateWatchZoneRequest`                                  | 201 `WatchZone`                                                |
| GET                | `/v1/watch-zones`                                    |                                                           | `WatchZone[]`, newest first                                    |
| GET                | `/v1/watch-zones/summaries`                          |                                                           | `WatchZoneSummary[]`, newest first                             |
| GET, PATCH, DELETE | `/v1/watch-zones/:zoneId`                            | PATCH: `UpdateWatchZoneRequest`                           | `WatchZone`; DELETE 204                                        |
| GET                | `/v1/edge-servers`                                   | `?zoneId`, `?unassigned=true`                             | `EdgeServer[]`                                                 |
| GET, PUT, DELETE   | `/v1/edge-servers/:edgeServerId`                     | PUT: `PutEdgeServerRequest`                               | `EdgeServer`; 409 unknown zone                                 |
| PATCH              | `/v1/edge-servers/:edgeServerId`                     | `UpdateEdgeServerRequest`                                 | `EdgeServer`; 404; 409 unknown zone                            |
| GET, POST, DELETE  | `/v1/watch-zones/:zoneId/placements`                 | POST: `CreatePlacementRequest`                            | `EdgeServerPlacement[]`; POST 201 one; DELETE 204 clears       |
| POST               | `/v1/watch-zones/:zoneId/placements/suggest`         | `SuggestPlacementsRequest`                                | `SuggestPlacementsResult`, replacing the placements            |
| PATCH, DELETE      | `/v1/placements/:placementId`                        | PATCH: `UpdatePlacementRequest`                           | `EdgeServerPlacement`; DELETE 204                              |
| POST               | `/v1/placements/:placementId/assign`                 | `AssignPlacementRequest`                                  | `EdgeServer`; 404 unknown placement or edge server             |
| GET                | `/v1/drones`                                         | `?edgeServerId`, `?zoneId`                                | `Drone[]`                                                      |
| GET, PUT, DELETE   | `/v1/drones/:droneId`                                | PUT: `PutDroneRequest`                                    | `Drone`; 409 unregistered edge server                          |
| POST               | `/v1/watch-zones/:zoneId/scans`                      | `StartScanRequest`                                        | 201 `Scan`; 409 one running or none placed; 502; 503           |
| GET                | `/v1/watch-zones/:zoneId/scans`                      |                                                           | `Scan[]`, newest first                                         |
| POST               | `/v1/watch-zones/:zoneId/scans/:runId/stop`          |                                                           | `Scan`, `stopping`; 409 not mapping; 502; 503                  |
| GET                | `/v1/mapping-runs`                                   | `?zoneId`, `?runId`, `?edgeServerId`                      | `MappingRun[]`, newest first                                   |
| GET, PUT, DELETE   | `/v1/mapping-runs/:runId/edge-servers/:edgeServerId` | PUT: the connector's `EdgeRun`                            | `MappingRun`; 409 unknown zone                                 |
| POST               | `/v1/detections`                                     | `DetectionsIngest`                                        | `DetectionsIngestResult`                                       |
| GET                | `/v1/detections`                                     | `?zoneId`, `?droneId`, `?edgeServerId`, `?risk`, `?since` | `DetectionFrame[]`, newest capture first                       |
| GET, DELETE        | `/v1/detections/:id`                                 |                                                           | `DetectionFrame`                                               |
| GET                | `/v1/watch-zones/:zoneId/risk-zones`                 |                                                           | `RiskZonesView`                                                |
| GET                | `/v1/watch-zones/:zoneId/surroundings`               | `?roads=false`                                            | `ZoneSurroundings`                                             |
| POST               | `/v1/watch-zones/:zoneId/surroundings/refresh`       |                                                           | 202 `ZoneSurroundings`, `pending`                              |
| GET                | `/v1/watch-zones/:zoneId/weather`                    |                                                           | `ZoneWeather`                                                  |
| POST               | `/v1/forest-fit`                                     | `ForestFitRequest`                                        | `ForestFitResult`; 404 no vegetation; 502; 503 open data off   |
| POST               | `/v1/watch-zones/:zoneId/planner-jobs`               | `CreatePlannerJobRequest`                                 | 202 `PlannerJob`; 400 no requester; 503 queue unavailable      |
| GET                | `/v1/watch-zones/:zoneId/planner-jobs`               |                                                           | `PlannerJob[]` without results                                 |
| GET                | `/v1/planner/jobs/:jobId`                            |                                                           | `PlannerJob` with `result`                                     |
| GET                | `/v1/watch-zones/:zoneId/planner-context`            | planner key                                               | `PlannerContext`                                               |
| POST               | `/v1/planner/jobs/:jobId/status`                     | planner key, `PlannerJobStatusUpdate`                     | 204; 409 once succeeded                                        |
| POST               | `/v1/planner/jobs/:jobId/result`                     | planner key, `PlannerResult`                              | 204; job `succeeded`                                           |
| POST               | `/v1/watch-zones/:zoneId/blasts`                     | `CreateBlastRequest`                                      | 201 `Blast`                                                    |
| GET                | `/v1/watch-zones/:zoneId/blasts`                     |                                                           | `Blast[]`, newest first                                        |
| POST               | `/v1/blasts/:blastId/approve`                        | operator session                                          | `Blast`, `queued`; 403 not an operator; again answers the same |
| GET                | `/v1/civilians`                                      | `zipCode` (5 digits)                                      | `Civilian[]`, oldest first; 403 unless `EMBER_AGENT_KEY`       |

- `phone` is E.164 (`+15551234567`), `zipCode` is a 5-digit US ZIP.
- `PUT` creates or replaces by id. On an edge server, omitted fields keep their value, so a connector
  re-registering with only its `url` keeps the zone, name, location and radius an operator set. The
  same holds for a drone's `name` and `kind`.
- An edge server's `live` is edge-manager's registry entry (`GET /v1/edge-servers` there), cached
  for 2 s; it is null when edge-manager is unset, unreachable within 1.5 s, or has not seen it.
- Setting a zone's `scanEveryHours` (1-168) schedules the next scan that far from now; null turns
  repeat scans off. Every 30 s the api starts the scans that are due (moving `nextScanAt` on first,
  so a failed start waits for the next interval) and ends active scans neither edge-manager nor any
  mapping run has updated for 10 minutes.
- Coverage and placement suggestions use a grid over the zone's bounding box (cell = radius / 8,
  clamped to 15-150 m, under 40,000 cells). Suggest is a greedy set cover after the zone's placed
  edge servers: it adds the site covering the most uncovered cells until the target is met, a site
  adds under 0.5% of the zone, or there are 60. Sites are named by compass point from the zone's
  centre and the lowest free number (`NE-1`), unique among the zone's edge servers and placements.
- Assigning a placement gives the edge server its zone, name, position and radius and deletes the
  placement, in one transaction.
- Starting a scan stores it `starting`, then sends edge-manager one `StartMappingTask` (altitude
  60-120 m, default cell 10 m) for the zone's edge servers with a position and radius. It is
  `mapping` when any edge server takes it (`error` lists the refusals), `failed` when none does,
  and `failed` with a 502 when edge-manager cannot be reached. Mapping-run `PUT`s move it on: a
  `starting` scan is `mapping`, and it is `done` once every edge server that took it reports `done`.
  A scan's `coverage` is the mean of its mapping runs'.
- A mapping run `PUT` adds the update's `newCells` to the stored set; the body's `runId` must match
  the path.
- Detections ingest skips frames already stored (same drone, `frameId` and `capturedAt`), so a
  retried batch is safe. Each frame is tagged with the zone of `edgeServerId` when the batch names
  one, else of the drone's registered edge server, at the time it arrives.
- Risk zones merge the zone's detections since its latest scan that did not fail (else the last 7
  days; newest 5,000 frames): each ground outline is rasterised onto a 10 m grid anchored at the
  boundary's south-west corner, a cell keeps its strongest class (`on_fire` over `at_risk`), and
  8-connected cells of one class form a zone with a convex-hull polygon and bounding box. A zone's
  id (`risk:row:col`) is stable while it grows away from its south-west corner.
- Surroundings are fetched from OpenStreetMap in the background when a zone is created or its
  boundary changes, and on `refresh`; the first `GET` of a zone without any starts the fetch.
  `status` is `pending` until it lands, `failed` with `error` when it cannot be fetched or open data
  is off.
- A planner job is stored, then pushed onto `ember:planner:jobs`; if Redis is unreachable the job is
  marked `failed` and the call answers 503. `requestedBy` defaults to the signed-in operator.
- The planner context carries the zone, its boundary, the detections of its newest 500 frames that
  found something, its risk zones, the civilian areas, roads, safe zones and stations of `ready`
  surroundings, and Open-Meteo weather at the zone's centre. Missing data is empty or null; the
  planner falls back and lists each assumption. Terrain is always null.
- A blast to responders only is `queued` at once. One that reaches civilians is `queued` only with
  an operator's approval: `approve: true` from a signed-in operator in the same call, or
  `POST /v1/blasts/:blastId/approve`; otherwise it stays `pending_approval`. `createdBy` is the
  operator's id or `service`.

## Run

```
pnpm --filter @ember/api dev
```

| Variable                 | Default                                   | Meaning                                                           |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`           | none                                      | Postgres; required                                                |
| `PORT`                   | `4001`                                    | Listen port                                                       |
| `EMBER_EDGE_KEY`         | unset                                     | Bearer key edge-manager calls with, and the api calls it with     |
| `EMBER_PLANNER_KEY`      | unset                                     | Bearer key the planner orchestrator calls with                    |
| `EMBER_AGENT_KEY`        | unset                                     | Bearer key operator-agent calls with; the only one that lists civilians |
| `EMBER_REDIS_URL`        | unset                                     | Planner job queue; unset, creating a planner job is 503           |
| `EMBER_EDGE_MANAGER_URL` | unset                                     | edge-manager's base URL; unset, scans are 503 and `live` is null  |
| `EMBER_API_ORIGINS`      | unset                                     | Comma-separated browser origins allowed besides localhost & Tauri |
| `EMBER_OPEN_DATA`        | on                                        | `off`: no forest fit (503), surroundings (failed) or weather      |
| `EMBER_OVERPASS_URL`     | `https://overpass-api.de/api/interpreter` | Overpass endpoint for forest fit and surroundings                 |
| `EMBER_OPEN_METEO_URL`   | `https://api.open-meteo.com/v1/forecast`  | Open-Meteo forecast endpoint for weather                          |
