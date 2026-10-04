# 0005: Edge manager and edge connector

**Status:** in-progress
**Touches:** services/edge-manager, services/edge-connector, internal/edgeproto, packages/contracts,
docs/architecture.md

## Goal

An edge-connector on an edge server pairs drone-runtimes over `/v1/drone`, keeps them and their
health in its own SQLite file, starts and stops mapping runs on them, relays swarm messages and
sends one deduplicated update of its swarm up. The edge-manager registers N connectors, fans the
API's start/stop tasks out to them and forwards what is new in their updates to drone-info.

## Plan

- [x] Contracts: `packages/contracts/src/edge.ts` (EdgeTask, ConnectorTask, uplink
      register/update, registry listing) and `internal/edgeproto/{task,uplink}.go`
- [x] edge-connector: identity (token, publishable URL), SQLite store (identity, drones and health,
      runs), drone WS server, run start/stop/resume, swarm relay, aggregation and dedupe, uplink
- [x] edge-manager: uplink WS (registration, live registry), `POST /v1/tasks` fan-out,
      `GET /v1/edge-servers`, updates turned into drone-info `DroneInfoIngest` batches
- [x] Tests per service; end to end with two real drone-runtimes, both Go services and drone-info
      (fleet and followed drone's telemetry and detections reach a `/v1/stream` viewer)
- [ ] api: edge server records, binding a registered connector (token) to a planned site, sending
      EdgeTask and reading `GET /v1/edge-servers`
- [ ] drone-info: take run state, mission status and newly mapped cells (needs an ingest message
      type; edge-manager drops them today). Coordinate with 0006, which owns the ingest contract.
- [ ] At-least-once to drone-info: today an update counts as taken once written to the manager's
      socket, so a manager crash between reading and forwarding loses that update's deltas. Fix by
      having the manager answer `ack` per seq after drone-info accepted it.
- [ ] Spatial merge of detections of the same fire seen by several drones (drone-info or planner)
- [ ] `EMBER_EDGE_KEY` added to `.env.example` (deny-listed for agents; add by hand)

## Decisions

- Tasks go manager to connector as HTTP `POST <connector url>/v1/tasks`, to the URL the API names.
  A command wants a per-connector answer (the swarm it launched, or why not), which HTTP gives
  without correlation ids. Rejected: tasks down the uplink socket. It would need no inbound
  reachability, but the API addresses connectors by URL.
- Registration is the uplink socket's first frame: the connector dials the manager's `/v1/edge`,
  sends `register` (id, URL), then streams `update`s. It is sent again on every reconnect, so the
  manager's registry is live state kept in memory and a manager restart loses nothing; in the end
  to end, a restarted manager had the connector back in 4 s. Mirrors drone `hello`/`welcome`.
- The connector's id is its token: `EMBER_EDGE_TOKEN` when set (pre-issued by the operator),
  otherwise generated on first boot and kept in SQLite. Its URL is `EMBER_EDGE_PUBLIC_URL`, or the
  address of the interface that routes to the manager plus the listen port.
- The task carries the geometry (edge server location, connectivity radius, zone boundary, cell
  size, altitude band). The API is the record of edge servers and zones, so a redrawn zone takes
  effect on the next run without touching the boxes. The connector adds the swarm: every drone
  connected when the task arrives.
- One run per connector at a time. Starting the active run id again is idempotent (manager
  retries). Another id gets 409 until every drone of the run has landed or gone 2 minutes without
  `mission_status` (the runtime sends it every second, landed included, until it restarts).
- A drone that reconnects mid-run gets `start_mapping` again only if this process saw it flying
  the run. A start to a drone that has landed would fly the run again. After a connector restart
  phases are unknown, so the resumed run is relayed but no start is resent.
- The update is a snapshot for state (every paired drone with its hello, latest telemetry and
  mission status; the run) and a delta for events (new detections, newly mapped cells).
    - Deltas leave the connector's queue only once the manager has taken them.
    - `seq` advances only on a taken update.
- Dedupe in the connector:
    - telemetry no newer than the drone's last `sentAt` is dropped;
    - a detections frame is kept once per (drone, frameId, capturedAt);
    - coverage cells are a set per run.
- edge-manager feeds drone-info through 0006's `POST /v1/ingest` (`DroneInfoIngest`) rather than a
  second endpoint of its own. drone-info treats every message as a sign of life, so the manager
  sends:
    - a drone's telemetry only when it changed;
    - its hello only while it is connected, refreshed every 30 s so a restarted drone-info learns
      names again;
    - every detections frame.
- Manager, connectors and the API's calls to the manager share `EMBER_EDGE_KEY` as a bearer token.
  Unset, it logs a warning and accepts anything (local dev). The drone link stays open: pairing is
  "place a drone near the box".
- Dependencies:
    - `github.com/coder/websocket`: context-aware, no transitive deps.
    - `modernc.org/sqlite` v1.46.1: pure Go, so the connector cross-compiles to a Mac mini or Pi
      without cgo. It is the newest release that supports Go 1.24; later ones need Go 1.26.

## Log

- 2026-10-03: contracts, both services, tests, docs.
    - Fixed on the way: `internal/edgeproto` had never compiled. The `StartMapping`/`StopMapping`
      task kinds clashed with the message types of the same names; they are now `Kind*`.
    - The end to end found `newCells: null` on the wire (now `[]`), and the manager forwarding a JSON
      `null` telemetry. Both are covered by tests.
    - `-race` was not run locally (no cgo toolchain on this machine); CI's `go-race` job covers it.
    - Next: the api side, then run state into drone-info.
