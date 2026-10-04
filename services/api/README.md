# @ember/api

Ember's record. See [docs/architecture.md](../../docs/architecture.md) for what this service owns.
Wire shapes are in [`packages/contracts/src/`](../../packages/contracts/src): `zone.ts`,
`incident.ts`, `responder.ts`, `civilian.ts`, `planner.ts`.

## Store

Prisma 7 against the shared Postgres in `compose.yaml`; `DATABASE_URL` comes from the root `.env`
(copy it next to this package or export it). The generated client in `src/generated/` is gitignored
and rebuilt by `build`, `typecheck` and `test`.

Civilians are a typed table (contact-collector's unique email). Every other record is one table per
collection, `(id, zone_id, doc jsonb, created_at)`, read and written by `src/store/collection.ts`;
the models in `prisma/schema.prisma` exist so migrations keep them. `EMBER_API_STORE=memory` runs the
same routes on in-process maps, for demos without Postgres; records are lost on restart.

```
pnpm --filter @ember/api db:deploy    # apply migrations
pnpm --filter @ember/api db:migrate   # create a migration after editing prisma/schema.prisma
EMBER_TEST_DATABASE_URL=postgresql://... pnpm --filter @ember/api test   # also runs the SQL store tests
```

## Auth

Bearer keys per role. A route whose roles have no key set is open, for local development; the api
logs which roles are open at start.

| Role       | Key                  | Used by                                         |
| ---------- | -------------------- | ----------------------------------------------- |
| `operator` | `EMBER_OPERATOR_KEY` | dashboard; the only key that decides approvals  |
| `agent`    | `EMBER_AGENT_KEY`    | operator-agent                                  |
| `planner`  | `EMBER_PLANNER_KEY`  | planner orchestrator                            |
| `ingest`   | `EMBER_INGEST_KEY`   | drone-info forwarding detections                |

"Staff" below means `operator` or `agent`. The responder bundle takes a responder session token.

## Routes

| Method | Path                                             | Who     | Does                                                                                                                                   |
| ------ | ------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                                       | anyone  | `{ service, ok }`                                                                                                                      |
| POST   | `/civilians`                                     | public  | `CreateCivilianRequest` → 201 `Civilian`; 400 invalid; 409 email registered. `email` stored lowercased, `zipCode` a 5-digit US ZIP     |
| GET    | `/v1/civilians?email=`                           | staff   | `Civilian[]`                                                                                                                           |
| GET    | `/v1/civilians/:civilianId`                      | staff   | `Civilian`                                                                                                                             |
| PATCH  | `/v1/civilians/:civilianId`                      | staff   | `UpdateCivilianRequest`; joining an area files the civilian under that area's zone                                                     |
| GET    | `/v1/watch-zones/:zoneId/civilians`              | staff   | civilians of the zone                                                                                                                  |
| POST   | `/v1/civilian-messages/inbound`                  | staff   | `InboundCivilianMessageRequest` → 201 `InboundCivilianMessageResult`; 404 unknown handle                                               |
| POST   | `/v1/civilian-messages`                          | staff   | `QueueCivilianMessageRequest` → 201 queued `CivilianMessage`. 403 without a matching approved alert or an open conversation (24 h)     |
| GET    | `/v1/civilian-messages?civilianId&direction&status&since` | staff | `CivilianMessage[]`                                                                                                             |
| PATCH  | `/v1/civilian-messages/:messageId`               | staff   | delivery: `{ status: sent \| failed, error? }`                                                                                         |
| GET    | `/v1/watch-zones`                                | staff   | `WatchZone[]`                                                                                                                          |
| POST   | `/v1/watch-zones`                                | staff   | `CreateWatchZoneRequest` (a boundary, or a centre and radius) → 201 `WatchZone`                                                        |
| GET    | `/v1/watch-zones/:zoneId`                        | staff   | `WatchZone`                                                                                                                            |
| GET    | `/v1/watch-zones/:zoneId/geography`              | staff   | `ZoneGeography`: terrain, roads with state, civilian areas, safe zones, stations                                                       |
| PUT    | `/v1/watch-zones/:zoneId/geography`              | staff   | replaces it; roads keep their reported state by id                                                                                     |
| GET    | `/v1/watch-zones/:zoneId/weather`                | staff   | `ZoneWeather` from the configured provider                                                                                             |
| GET    | `/v1/watch-zones/:zoneId/surveillance`           | staff   | `SurveillancePlan \| null`                                                                                                             |
| PUT    | `/v1/watch-zones/:zoneId/surveillance`           | staff   | records the scan cadence operator-agent chose                                                                                          |
| GET    | `/v1/watch-zones/:zoneId/roads`                  | staff   | `Road[]` with state                                                                                                                    |
| POST   | `/v1/watch-zones/:zoneId/road-observations`      | staff   | `RoadObservationRequest` → 201 `RoadObservation[]`, one per segment of the road; 404 / 409 `RoadMatchError` with candidates           |
| GET    | `/v1/watch-zones/:zoneId/road-observations`      | staff   | newest first                                                                                                                           |
| GET    | `/v1/watch-zones/:zoneId/risk-zones`             | staff   | `RiskZoneRecord[]`                                                                                                                     |
| POST   | `/v1/watch-zones/:zoneId/risk-zones`             | staff   | `CreateRiskZoneRequest` → 201                                                                                                          |
| DELETE | `/v1/watch-zones/:zoneId/risk-zones/:riskZoneId` | staff   | 204; removes a risk zone from future plans                                                                                             |
| POST   | `/v1/detections`                                 | ingest  | a `DroneDetections` frame → `DetectionsIngestResult`; each detection filed under the zone containing it, a repeat refines one record   |
| GET    | `/v1/watch-zones/:zoneId/detections?since&verification` | staff | `DetectionRecord[]`, newest first                                                                                                  |
| POST   | `/v1/watch-zones/:zoneId/detections/simulated`   | staff   | `SimulatedDetectionRequest` → 201; source `simulated`                                                                                  |
| GET    | `/v1/detections/:detectionId`                    | staff   | `DetectionRecord`                                                                                                                      |
| PATCH  | `/v1/detections/:detectionId`                    | staff   | `DetectionVerificationRequest`; `confirmed` files the detection as a risk zone                                                         |
| GET    | `/v1/watch-zones/:zoneId/edge-servers`           | staff   | `EdgeServerRecord[]` with edge-manager's live status when it answers                                                                   |
| POST   | `/v1/watch-zones/:zoneId/edge-servers`           | staff   | `RegisterEdgeServerRequest` → 201; 409 registered                                                                                      |
| GET    | `/v1/watch-zones/:zoneId/scans`                  | staff   | `Scan[]`, newest first                                                                                                                 |
| POST   | `/v1/watch-zones/:zoneId/scans`                  | staff   | `StartScanRequest` → 201 `Scan`; sends `start_mapping` to edge-manager. A focused scan maps a circle with the edge servers that reach it. An unreachable edge plane gives a `failed` scan with the error. 409 no edge servers |
| POST   | `/v1/scans/:runId/stop`                          | staff   | `StopScanRequest` → `Scan`; sends `stop_mapping`                                                                                       |
| GET    | `/v1/watch-zones/:zoneId/planner-context`        | planner, staff | `PlannerContext`: geography, weather, risk zones, unconfirmed and undismissed detections                                       |
| POST   | `/v1/watch-zones/:zoneId/planner-jobs`           | staff   | `EnqueuePlannerJobRequest` → 202 `PlannerJob`; LPUSHes a `PlannerJobRequest` on `ember:planner:jobs`. 503 when Redis is down          |
| GET    | `/v1/watch-zones/:zoneId/planner-jobs`           | staff   | the last 50 `PlannerJob`s                                                                                                              |
| GET    | `/v1/watch-zones/:zoneId/planner-jobs/latest`    | staff   | the newest succeeded `PlannerJobView`; 404 none                                                                                        |
| GET    | `/v1/planner/jobs/:jobId`                        | staff   | `PlannerJobView`: the job and its `PlannerResult` once succeeded                                                                       |
| POST   | `/v1/planner/jobs/:jobId/status`                 | planner | `PlannerJobStatusUpdate`                                                                                                               |
| POST   | `/v1/planner/jobs/:jobId/result`                 | planner | `PlannerResult`; marks the job succeeded and moves its incident's latest and previous plan                                             |
| GET    | `/v1/watch-zones/:zoneId/incidents`              | staff   | `Incident[]`                                                                                                                           |
| POST   | `/v1/watch-zones/:zoneId/incidents`              | staff   | `CreateIncidentRequest` → 201, numbered                                                                                                |
| GET    | `/v1/incidents/:incidentId`                      | staff   | `IncidentView`: the incident and its timeline                                                                                          |
| PATCH  | `/v1/incidents/:incidentId`                      | staff   | `UpdateIncidentRequest`; a state change adds a timeline event                                                                          |
| POST   | `/v1/incidents/:incidentId/events`               | staff   | `CreateIncidentEventRequest` → 201                                                                                                     |
| GET    | `/v1/approvals?state&zoneId`                     | staff   | `Approval[]`                                                                                                                           |
| POST   | `/v1/approvals`                                  | staff   | `CreateApprovalRequest` → 201 pending `Approval` with a 4-character confirmation code                                                  |
| GET    | `/v1/approvals/:approvalId`                      | staff   | `Approval`                                                                                                                             |
| POST   | `/v1/approvals/:approvalId/decision`             | operator| `ApprovalDecisionRequest`; 409 when not pending or the code differs                                                                    |
| GET    | `/v1/watch-zones/:zoneId/reports?unprocessed=true` | staff | `FieldReport[]`                                                                                                                        |
| POST   | `/v1/watch-zones/:zoneId/reports`                | staff   | `CreateFieldReportRequest` → 201                                                                                                       |
| PATCH  | `/v1/reports/:reportId`                          | staff   | `ProcessFieldReportRequest`: marks it handled                                                                                          |
| GET    | `/v1/watch-zones/:zoneId/responders`             | staff   | `Responder[]`                                                                                                                          |
| POST   | `/v1/watch-zones/:zoneId/responders`             | staff   | `CreateResponderRequest` → 201, numbered                                                                                               |
| PATCH  | `/v1/responders/:responderId`                    | staff   | `UpdateResponderRequest`                                                                                                               |
| GET    | `/v1/watch-zones/:zoneId/assignments?state&responderId&incidentId` | staff | `ResponderAssignment[]`                                                                                                 |
| POST   | `/v1/watch-zones/:zoneId/assignments`            | staff   | `AssignRespondersRequest` → `AssignRespondersResult` (below)                                                                           |
| GET    | `/v1/watch-zones/:zoneId/responder-messages?responderId` | staff | newest 200 `ResponderMessage`s                                                                                                  |
| POST   | `/v1/watch-zones/:zoneId/responder-messages`     | staff   | `SendResponderMessageRequest` → 201; `responderId: null` is the whole zone                                                             |
| POST   | `/v1/watch-zones/:zoneId/responder-pairing-codes`| staff   | `CreatePairingCodeRequest` → 201 `ResponderPairingCode`, valid 10 min, single use                                                      |
| POST   | `/v1/responders/pair`                            | public  | `ResponderPairRequest` → 201 `ResponderSession`; 401 unknown or expired code                                                           |
| GET    | `/v1/responders/zones/:zoneId/bundle`            | session | `ResponderZoneBundle` with the responder's messages and assignment; `ETag`, 304 on `If-None-Match`                                    |

### Responder assignment

Attack zones in rank order; each gets `perZone` responders (default 1). An active assignment of the
same incident stays when its zone's drop site moved under 50 m and its approach uses the same roads;
otherwise it is superseded and its responder is free again. Free responders are taken by number,
those at the station the zone's approach starts from first. Instructions are built from the plan:
incident number, zone letter, the road of the drop site, the approach bearing, fire arrival and
tactic. Anything geospatial or optimising belongs in the planner, not here.

## Run

```
pnpm --filter @ember/api dev
EMBER_API_STORE=memory pnpm --filter @ember/api dev     # no Postgres
```

| Variable                      | Default                                  | Meaning                                                        |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `PORT`                        | `4001`                                   |                                                                |
| `DATABASE_URL`                | none                                     | Postgres; required unless `EMBER_API_STORE=memory`             |
| `EMBER_API_STORE`             | `prisma`                                 | `prisma` or `memory`                                           |
| `EMBER_REDIS_URL`             | `redis://localhost:6379/0`               | planner queue                                                  |
| `EMBER_EDGE_MANAGER_URL`      | `http://localhost:8060`                  | edge-manager                                                   |
| `EMBER_EDGE_KEY`              | none                                     | bearer for edge-manager                                        |
| `EMBER_WEATHER_PROVIDER`      | `fixture`                                | `fixture`, `demo-data` or `nws`                                |
| `EMBER_SCENARIO_START`        | `2023-08-08T12:00:00-10:00`              | fixture: scenario time at api start                            |
| `EMBER_SCENARIO_SPEED`        | `30`                                     | fixture: scenario seconds per second                           |
| `EMBER_DEMO_DATA_URL`         | `http://localhost:8090`                  | demo-data, for `demo-data` weather                             |
| `EMBER_NWS_USER_AGENT`        | `ember (dev)`                            | NWS asks for a contact in the User-Agent                       |
| `EMBER_PUBLIC_API_URL`        | `http://localhost:$PORT`                 | the api URL in pairing codes and sessions                      |
| `EMBER_PUBLIC_DRONE_INFO_URL` | none                                     | drone-info URL handed to responder apps                        |
| `EMBER_SCAN_CELL_M`           | `10`                                     | mapping cell size sent to edge servers                         |
| `EMBER_OPERATOR_KEY`, `EMBER_AGENT_KEY`, `EMBER_PLANNER_KEY`, `EMBER_INGEST_KEY` | none | role keys (above)                                   |

The `fixture` weather follows Kahului-area conditions through the Aug 8, 2023 wind event,
approximately and deterministically, on a clock that starts at `EMBER_SCENARIO_START`.
