# Architecture

Ember is a monorepo of independently deployable services that share one gate, one contracts
package and one data store per concern. Product behaviour is specified in `readme.md`; this document
owns the boundaries.

## Services

| Service        | Lang      | Path                      | Owns                                                                                      |
| -------------- | --------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| api            | TS        | `services/api`            | Auth, civilians, watch zones, edge server + drone registry, scans, planner jobs. Record.  |
| drone-info     | TS        | `services/drone-info`     | Live drone telemetry and detections; streams to dashboard, responder and drone-sim.       |
| messenger      | TS        | `services/messenger`      | Operator to responder 1-N messaging, event blasts; routes civilian blasts to voice-agent. |
| voice-agent    | TS        | `services/voice-agent`    | ElevenLabs outbound calls and inbound hotline.                                            |
| operator-agent | TS        | `services/operator-agent` | Natural-language copilot calling the same API actions as the dashboard. uAgent.           |
| edge-manager   | Go        | `services/edge-manager`   | Single API link; fans tasks out to N edge connectors, aggregates telemetry up.            |
| edge-connector | Go        | `services/edge-connector` | Local drone network per edge server: pairing, task fan-out, WS run channel.               |
| planner        | Python    | `services/planner`        | Celery orchestrator (Redis queue) and workers: spread prediction, evacuation, response.   |
| drone-runtime  | Python    | `services/drone-runtime`  | On-drone flight, swarm mapping of the edge's radius, risk detection, reports up.          |
| dashboard      | Rust + TS | `apps/dashboard`          | Operator desktop app (Tauri).                                                             |
| responder      | TS        | `apps/responder`          | Responder mobile app (Expo), offline-first zone map.                                      |
| civilian-map   | TS        | `apps/civilian-map`       | Read-only evacuation map linked from texts.                                               |
| drone-sim      | Rust + TS | `apps/drone-sim`          | Desktop 3D view of one connected drone (from drone-info) and what it sees.                |
| demo-data      | Python    | `services/demo-data`      | Lahaina Aug 2023 scenario: drone camera frames, fire model, 3D world for drone-sim.       |
| seed data      | Python    | `tools/demo-data`         | Seed data generators.                                                                     |
| asset-builder  | Python    | `tools/asset-builder`     | Generates the low-poly 3D models in `assets/` (drone, trees, buildings, fire, smoke).     |

## Channels

Each arrow is the only way those two talk. Anything else is a boundary violation.

```
dashboard ──HTTP/WS──▶ api ──HTTP──▶ edge-manager ──WS──▶ edge-connector ──WS──▶ drone-runtime
                        │                 ▲                     │
                        │                 └──── telemetry ──────┘
                        │      edge-manager ──HTTP──▶ drone-info ──WS──▶ dashboard, responder, drone-sim
                        ├──Redis queue──▶ planner (orchestrator ▶ workers) ──result──▶ api
                        ├──HTTP──▶ messenger ──push──▶ responder
                        │               └──HTTP──▶ voice-agent
operator-agent ──HTTP (same routes as dashboard)──▶ api
voice-agent ──HTTP tools──▶ api
civilian-map ──HTTP (public read-only)──▶ api

drone-runtime ──WS /v1/drone (droneLink.ts)──▶ edge-connector  (hello, telemetry, detections, swarm)
drone-runtime ──WS /v1/stream──▶ demo-data                      (simulated camera frames)
drone-info ──WS /v1/stream (droneInfo.ts)──▶ drone-sim           (fleet, followed drone's pose and detections)
drone-sim ──HTTP /v1/world──▶ demo-data                          (3D world: trees, buildings, roads, fire)
```

The drones of a mapping run coordinate only through their edge-connector, which relays each
`swarm` message to the other drones of the run. There is no drone-to-drone link: a drone that
cannot reach its edge server is outside the run's connectivity radius anyway.

drone-sim renders only what these two report: it moves no drone and runs no detector. Until
drone-info is built, it plays one stationary dummy drone in its place
(`apps/drone-sim/src/droneInfo/dummy.ts`), which reads Demo Data's `/v1/clock` and `/v1/observation`
as a drone would.

## Data

- **Postgres + PostGIS**: owned by `api`. Zone boundaries, coverage and risk cells are geometry.
  Agents keep per-civilian memory in their own schema, reached only through their service.
- **Redis**: planner job queue and results; pub/sub for live telemetry fan-out.
- **Edge-connector local store**: paired drones per edge server.

## Contracts

`packages/contracts` is the TypeScript source of truth for cross-service shapes. Go mirrors live in
`internal/`; Python mirrors live in the consuming package. Field names are camelCase on the wire.

## Invariants

- Outbound civilian alerts require an operator approval record (see `AGENTS.md`).
- The API is the only writer of watch zones, edge servers and drone registrations.
- Every service exposes `GET /healthz`.
