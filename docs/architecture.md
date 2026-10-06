# Architecture

Ember is a monorepo of independently deployable services that share one gate, one contracts
package and one data store per concern. Product behaviour is specified in `docs/product.md`; this document
owns the boundaries.

## Services

| Service           | Lang      | Path                       | Owns                                                                                                                                                                                                          |
| ----------------- | --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api               | TS        | `services/api`             | Operator accounts, civilians, watch zones, planned edge server sites, edge server + drone registry, scans and mapping runs, detections and risk zones, zone surroundings, planner jobs, event blasts. Record. |
| drone-info        | TS        | `services/drone-info`      | Live drone telemetry and detections; streams to dashboard and drone-sim.                                                                                                                                      |
| operator-agent    | TS        | `services/operator-agent`  | Incident response: on drone-detected fire, requests a plan, posts responder staging, drafts per-ZIP evacuation alerts and texts the approved ones (iMessage via Photon).                                      |
| operator-uagent   | Python    | `services/operator-uagent` | Fetch.ai uAgent on Agentverse: relays ASI:One chat to operator-agent. Holds no state.                                                                                                                         |
| edge-manager      | Go        | `services/edge-manager`    | Single API link; live registry of edge connectors, task fan-out, their updates on.                                                                                                                            |
| edge-connector    | Go        | `services/edge-connector`  | One edge server's drone network: pairing, drone health, runs, swarm relay, updates up.                                                                                                                        |
| planner           | Python    | `services/planner`         | Orchestrator (Redis queue) and Celery workers: fire spread, attack zones, evacuation.                                                                                                                         |
| drone-runtime     | Python    | `services/drone-runtime`   | On-drone flight, swarm mapping of the edge's radius, risk detection, reports up.                                                                                                                              |
| dashboard         | Rust + TS | `apps/dashboard`           | Operator desktop app (Tauri) on the api's records and drone-info's live fleet.                                                                                                                                |
| civilian-map      | TS        | `apps/civilian-map`        | Read-only evacuation map linked from texts.                                                                                                                                                                   |
| contact-collector | TS        | `apps/contact-collector`   | Public signup page. Validates phone and ZIP, then creates a civilian through the API.                                                                                                                         |
| drone-sim         | Rust + TS | `apps/drone-sim`           | Desktop 3D view of one connected drone (from drone-info) and what it sees.                                                                                                                                    |
| demo-data         | Python    | `services/demo-data`       | Lahaina Aug 2023 scenario: drone camera frames, fire model, 3D world for drone-sim.                                                                                                                           |
| seed-data         | Python    | `tools/seed-data`          | Seed data generators for the api database.                                                                                                                                                                    |
| asset-builder     | Python    | `tools/asset-builder`      | Generates the low-poly 3D models in `assets/` (drone, trees, buildings, fire, smoke).                                                                                                                         |
| fire-seg          | Python    | `tools/fire-seg`           | Fire segmentation dataset, training and ONNX export of drone-runtime's YOLO model.                                                                                                                            |

## Channels

Each arrow is the only way those two talk. Anything else is a boundary violation.

```
dashboard ──HTTP──▶ api ──HTTP──▶ edge-manager ──HTTP──▶ edge-connector ──WS──▶ drone-runtime
                        │                 ▲                       │
                        │                 └── register, updates ──┘
                        │      edge-manager ──HTTP──▶ drone-info ──WS──▶ dashboard, drone-sim
                        ├──Redis queue──▶ planner (orchestrator ▶ workers) ──result──▶ api
operator-agent ──HTTP (same routes as dashboard)──▶ api
ASI:One ──Agentverse mailbox──▶ operator-uagent ──HTTP──▶ operator-agent
civilian-map ──HTTP (public read-only)──▶ api
contact-collector ──HTTP──▶ api                         (POST /civilians)
operator-agent ──HTTP GET /v1/civilians (api.ts)──▶ api  (phones in one ZIP; EMBER_AGENT_KEY only)
operator-agent ──Photon Spectrum (iMessage)──▶ civilians (approved evacuation blasts)
operator-agent ──Photon Spectrum (iMessage)──▶ operator's notify phone (each evacuation plan with its route map)
operator's notify phone ──Photon Spectrum (iMessage)──▶ operator-agent (asks for a new route)
operator-agent ──HTTPS (Anthropic API, Claude Haiku)──▶ Anthropic (is a notify-phone text a new-route request)
operator-agent ──HTTPS──▶ OpenStreetMap Nominatim, tiles (the ZIP of each civilian area, route map)
operator-uagent ──HTTP POST /v1/chat (agent.ts)──▶ operator-agent

api ──HTTP /v1/tasks, /v1/edge-servers (edge.ts)──▶ edge-manager (start/stop a zone's run, registry)
edge-manager ──HTTP /v1/tasks (edge.ts)──▶ edge-connector        (start/stop on one edge server)
edge-connector ──WS /v1/edge (edge.ts)──▶ edge-manager           (register, then aggregated updates)
edge-manager ──HTTP /v1/ingest (droneInfo.ts)──▶ drone-info      (hellos, changed telemetry, detections)
edge-manager ──HTTP /v1/edge-servers, /v1/drones, /v1/mapping-runs, /v1/detections (api.ts)──▶ api
                                                                 (registrations, drones, run coverage, detections)
drone-runtime ──WS /v1/drone (droneLink.ts)──▶ edge-connector  (hello, telemetry, detections, swarm)
drone-runtime ──WS /v1/stream──▶ demo-data                      (simulated camera frames)
drone-info ──WS /v1/stream (droneInfo.ts)──▶ drone-sim           (fleet, followed drone's pose and detections)
drone-info ──WS /v1/stream (droneInfo.ts)──▶ dashboard           (fleet, every report of the open zone's drones)
api ──HTTPS──▶ OpenStreetMap Overpass, Open-Meteo                (forest fit, zone surroundings, weather)
drone-sim ──HTTP /v1/world──▶ demo-data                          (3D world: trees, buildings, roads, fire)
fire-seg ──HTTP /v1/truth/fire, /v1/observation──▶ demo-data      (training frames with truth labels)
api ──Redis list ember:planner:jobs (planner.ts)──▶ planner orchestrator  (PlannerJobRequest)
planner orchestrator ──HTTP planner-context, status, result (planner.ts)──▶ api
planner orchestrator ──Celery over Redis, queue planner──▶ planner workers  (job + context in, result back)
```

The planner never reads the api's database: the orchestrator fetches each job's `PlannerContext`
(zone boundary, terrain, weather, risk zones, detections, civilian areas, roads, safe zones,
stations) from the api, and workers see only what the orchestrator hands them. The api builds it
from what it holds: risk zones merged from the zone's detections since its latest scan, the
surroundings (civilian areas, roads, safe zones, stations) it fetched from OpenStreetMap when the
zone was created or its boundary changed, and Open-Meteo's current weather.

The dashboard reads and changes everything through the api, polling what the open page shows, and
watches the open zone's drones on drone-info's stream for their live position and detections.
Operators sign in to the api and send its session token on the same `/v1` routes the services call
with their keys.

edge-manager posts what drones report to drone-info's `/v1/ingest` (`DroneInfoIngest`), and records
at the api what the api keeps: each connector's registration, its drones with their names, each
run's newly mapped cells and every detections frame. Without the Go edge services running, `drone-runtime swarm-sim --drone-info` posts there in their place:
its in-process edge stands in for both, as drone-sim's dummy feed stands in when no drone-info URL is
given.

An edge-connector registers by opening its uplink to edge-manager and sending `register` (its token
and the URL edge-manager reaches it at), again on every reconnect, so edge-manager's registry is live
state with no store of its own. The api reads that registry for each edge server's live status.
An operator plans sites for a zone (placements), and a registered connector becomes one of the
zone's edge servers when the operator assigns it to a site. A scan sends one `StartMappingTask` for
every edge server of the zone with a position, naming each one's URL; the api marks the scan done
when every edge server that took it reports its run done, and starts repeat scans on the zone's
schedule.
edge-manager, its connectors and the API's calls to edge-manager carry one shared bearer key,
`EMBER_EDGE_KEY`. The drone link has none: a drone pairs by being on the edge server's network.
Each edge-connector announces its drone link over mDNS (`_ember-edge._tcp`, `droneLink.ts`), so a
drone started without an edge URL finds it on the local network.

The drones of a mapping run coordinate only through their edge-connector, which relays each
`swarm` message to the other drones of the run without reading more than its coverage cells. There
is no drone-to-drone link: a drone that cannot reach its edge server is outside the run's
connectivity radius anyway. Coverage messages also carry the fire evidence each drone's own frames
added per cell, so every drone of the run confirms detections on what all of them saw.

fire-seg is a development tool, not a running service. It imports drone-runtime's perception
package to score models through the exact code the drone runs, and ships nothing to drones but the
ONNX file: the released one is committed under `data/fire-seg/models/` and drone-runtime loads it by
default (`EMBER_YOLO_MODEL` overrides it).

drone-sim renders only what these two report: it moves no drone and runs no detector. Without a
drone-info URL it plays one stationary dummy drone instead (`apps/drone-sim/src/droneInfo/dummy.ts`),
which reads Demo Data's `/v1/clock` and `/v1/observation` as a drone would.

## Data

- **Postgres + PostGIS**: owned by `api`. Zone boundaries and detection outlines are JSONB `LatLng`
  rings; run coverage is cell indices on the grid `MappingMission` defines. Operator passwords are
  scrypt hashes and session tokens are stored only as their SHA-256. Agents keep per-civilian
  memory in their own schema, reached only through their service.
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

`compose.yaml` runs every service and contact-collector on one machine from the same
Dockerfiles. The desktop apps (dashboard on 5173, drone-sim on 5180) are not in it: they run on the
host with pnpm and call the services at `localhost:<port>`, so every port is published:

| Port | Service              | Port | Service                |
| ---- | -------------------- | ---- | ---------------------- |
| 4001 | api                  | 4008 | planner worker         |
| 4002 | drone-info           | 8060 | edge-manager           |
| 4006 | operator-agent       | 8070 | edge-connector         |
| 4007 | planner orchestrator | 8090 | demo-data (`/control`) |
| 4010 | contact-collector    | 5432 | postgres, 6379 redis   |

operator-uagent is not in compose. It is a uv project of its own, outside the root workspace, with
its own lock: uagents pins protobuf below 6, which would hold drone-runtime and fire-seg back. It runs
on the host and reaches ASI:One through its Agentverse mailbox.

`api-migrate` applies Prisma migrations before the api starts. `drone-fleet` runs two simulated
drones (drone-runtime `fleet`, `sim-1` and `sim-2`) that pair with the edge-connector and see Demo
Data's world over Lahaina, so the dashboard's scans fly them end to end. A Raspberry Pi drone
pointed at the published edge-connector port joins the same runs as a third. demo-data mounts the
host's `./data`, built beforehand.

## Contracts

`packages/contracts` is the TypeScript source of truth for cross-service shapes. Go mirrors live in
`internal/`; Python mirrors live in the consuming package. Field names are camelCase on the wire.

## Invariants

- Outbound civilian alerts require an operator approval record (see `CONTRIBUTING.md`): the api keeps a
  blast that reaches civilians `pending_approval` until a signed-in operator approves it, and
  operator-agent texts a blast only once it is `queued` with that approval.
- The API is the only writer of watch zones, edge servers and drone registrations. A connector's
  pairings and edge-manager's registry are live state, not a second record.
- Every service exposes `GET /healthz`.
