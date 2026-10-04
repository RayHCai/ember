# Architecture

Ember is a monorepo of independently deployable services that share one gate, one contracts
package and one data store per concern. Product behaviour is specified in `readme.md`; this document
owns the boundaries.

## Services

| Service           | Lang      | Path                      | Owns                                                                                     |
| ----------------- | --------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| api               | TS        | `services/api`            | Auth, civilians, watch zones, edge server + drone registry, scans, planner jobs. Record. |
| drone-info        | TS        | `services/drone-info`     | Live drone telemetry and detections; streams to dashboard, responder and drone-sim.      |
| operator-agent    | TS        | `services/operator-agent` | Natural-language copilot calling the same API actions as the dashboard. uAgent.          |
| edge-manager      | Go        | `services/edge-manager`   | Single API link; live registry of edge connectors, task fan-out, their updates on.       |
| edge-connector    | Go        | `services/edge-connector` | One edge server's drone network: pairing, drone health, runs, swarm relay, updates up.   |
| planner           | Python    | `services/planner`        | Orchestrator (Redis queue) and Celery workers: fire spread, attack zones, evacuation.    |
| drone-runtime     | Python    | `services/drone-runtime`  | On-drone flight, swarm mapping of the edge's radius, risk detection, reports up.         |
| dashboard         | Rust + TS | `apps/dashboard`          | Operator desktop app (Tauri).                                                            |
| responder         | TS        | `apps/responder`          | Responder mobile app (Expo), offline-first zone map.                                     |
| civilian-map      | TS        | `apps/civilian-map`       | Read-only evacuation map linked from texts.                                              |
| contact-collector | TS        | `apps/contact-collector`  | Public signup page. Validates email and ZIP, then creates a civilian through the API.    |
| drone-sim         | Rust + TS | `apps/drone-sim`          | Desktop 3D view of one connected drone (from drone-info) and what it sees.               |
| demo-data         | Python    | `services/demo-data`      | Lahaina Aug 2023 scenario: drone camera frames, fire model, 3D world for drone-sim.      |
| seed-data         | Python    | `tools/seed-data`         | Seed data generators for the api database.                                               |
| asset-builder     | Python    | `tools/asset-builder`     | Generates the low-poly 3D models in `assets/` (drone, trees, buildings, fire, smoke).    |
| fire-seg          | Python    | `tools/fire-seg`          | Fire segmentation dataset, training and ONNX export of drone-runtime's YOLO model.       |

## Channels

Each arrow is the only way those two talk. Anything else is a boundary violation.

```
dashboard ──HTTP/WS──▶ api ──HTTP──▶ edge-manager ──HTTP──▶ edge-connector ──WS──▶ drone-runtime
                        │                 ▲                       │
                        │                 └── register, updates ──┘
                        │      edge-manager ──HTTP──▶ drone-info ──WS──▶ dashboard, responder, drone-sim
                        ├──Redis queue──▶ planner (orchestrator ▶ workers) ──result──▶ api
operator-agent ──HTTP (same routes as dashboard)──▶ api
civilian-map ──HTTP (public read-only)──▶ api
contact-collector ──HTTP──▶ api                         (POST /civilians)
responder ──HTTP pair, zone bundle (responder.ts)──▶ api        (QR token for a session; offline bundle)

api ──HTTP /v1/tasks, /v1/edge-servers (edge.ts)──▶ edge-manager (start/stop a zone's run, registry)
edge-manager ──HTTP /v1/tasks (edge.ts)──▶ edge-connector        (start/stop on one edge server)
edge-connector ──WS /v1/edge (edge.ts)──▶ edge-manager           (register, then aggregated updates)
edge-manager ──HTTP /v1/ingest (droneInfo.ts)──▶ drone-info      (hellos, changed telemetry, detections)
drone-runtime ──WS /v1/drone (droneLink.ts)──▶ edge-connector  (hello, telemetry, detections, swarm)
drone-runtime ──WS /v1/stream──▶ demo-data                      (simulated camera frames)
drone-info ──WS /v1/stream (droneInfo.ts)──▶ drone-sim           (fleet, followed drone's pose and detections)
drone-sim ──HTTP /v1/world──▶ demo-data                          (3D world: trees, buildings, roads, fire)
fire-seg ──HTTP /v1/truth/fire, /v1/observation──▶ demo-data      (training frames with truth labels)
api ──Redis list ember:planner:jobs (planner.ts)──▶ planner orchestrator  (PlannerJobRequest)
planner orchestrator ──HTTP planner-context, status, result (planner.ts)──▶ api
planner orchestrator ──Celery over Redis, queue planner──▶ planner workers  (job + context in, result back)
```

The planner never reads the api's database: the orchestrator fetches each job's `PlannerContext`
(zone boundary, terrain, weather, risk zones, detections, civilian areas, roads, safe zones,
stations) from the api, and workers see only what the orchestrator hands them.

The responder app joins a watch zone by scanning a QR code from the dashboard: a short-lived
`ResponderPairingCode` it trades at the api for a session, which names the drone-info
URL. It downloads one `ResponderZoneBundle` (boundary, terrain, roads, risk zones, detections, the
latest plan, recent messages) and keeps it on the device, so the map works with no signal. Online, it
re-fetches the bundle with `If-None-Match` every 30 s while open.

edge-manager posts what drones report to drone-info's `/v1/ingest` (`DroneInfoIngest`). Without the Go
edge services running, `drone-runtime swarm-sim --drone-info` posts there in their place:
its in-process edge stands in for both, as drone-sim's dummy feed stands in when no drone-info URL is
given.

An edge-connector registers by opening its uplink to edge-manager and sending `register` (its token
and the URL edge-manager reaches it at), again on every reconnect, so edge-manager's registry is live
state with no store of its own. The API names each edge server's URL in the tasks it sends.
edge-manager, its connectors and the API's calls to edge-manager carry one shared bearer key,
`EMBER_EDGE_KEY`. The drone link has none: a drone pairs by being on the edge server's network.

The drones of a mapping run coordinate only through their edge-connector, which relays each
`swarm` message to the other drones of the run without reading more than its coverage cells. There
is no drone-to-drone link: a drone that cannot reach its edge server is outside the run's
connectivity radius anyway. Coverage messages also carry the fire evidence each drone's own frames
added per cell, so every drone of the run confirms detections on what all of them saw.

fire-seg is a development tool, not a running service. It imports drone-runtime's perception
package to score models through the exact code the drone runs, and ships nothing to drones but the
ONNX file an operator copies over (`EMBER_YOLO_MODEL`).

drone-sim renders only what these two report: it moves no drone and runs no detector. Without a
drone-info URL it plays one stationary dummy drone instead (`apps/drone-sim/src/droneInfo/dummy.ts`),
which reads Demo Data's `/v1/clock` and `/v1/observation` as a drone would.

## Data

- **Postgres + PostGIS**: owned by `api`. Zone boundaries, coverage and risk cells are geometry.
  Agents keep per-civilian memory in their own schema, reached only through their service.
- **Redis**: planner job queue and results; pub/sub for live telemetry fan-out.
- **Edge-connector local store**: one SQLite file per edge server: its token, paired drones with
  their last health, and its runs. Read by nothing else.

## Deployment

Each deployable service is one container image, built from the Dockerfile for its language in
`docker/`. `.github/workflows/images.yml` maps services to Dockerfiles: CI builds every image, and a
release pushes them to GHCR tagged with the version, `sha-<commit>` and `latest`. Go images are
static binaries on distroless whose working directory, `/data`, holds edge-connector's SQLite store.
The planner image takes `orchestrator` or `worker` as its argument. drone-runtime ships to drones,
not to a registry. demo-data and drone-sim are local demo tooling.

## Contracts

`packages/contracts` is the TypeScript source of truth for cross-service shapes. Go mirrors live in
`internal/`; Python mirrors live in the consuming package. Field names are camelCase on the wire.

## Invariants

- Outbound civilian alerts require an operator approval record (see `AGENTS.md`).
- The API is the only writer of watch zones, edge servers and drone registrations. A connector's
  pairings and edge-manager's registry are live state, not a second record.
- Every service exposes `GET /healthz`.
