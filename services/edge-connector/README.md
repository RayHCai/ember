# @ember/edge-connector

One edge server's drone network. Drones on its network pair with it over a WebSocket. It keeps them
and their health in its own SQLite file, starts and stops mapping runs on them, relays swarm
messages between the drones of a run, and sends edge-manager one deduplicated update of the whole
swarm about 20 times a second. Nothing else talks to a drone-runtime.

## Contract

- **Drone link** (`packages/contracts/src/droneLink.ts`): WebSocket at `/v1/drone`.
    - The drone sends `hello` first; the connector pairs it and answers `welcome`.
    - Down: `start_mapping`, `stop_mapping`, and `swarm` relayed from the other drones of the run.
    - Up: `telemetry`, `detections`, `mission_status`, `swarm`.
    - A message whose `droneId` is not the drone that owns the socket is dropped.
- **Tasks** (`edge.ts`): `POST /v1/tasks` with a `ConnectorTask`, from edge-manager.
    - Answers `ConnectorTaskResult` (the run's drones), or `{ error }` with 400, 401, 404 or 409.
- **Uplink** (`edge.ts`): WebSocket to edge-manager's `/v1/edge`.
    - `register` on every connect, then an `EdgeUpdate` every `EMBER_EDGE_UPDATE_MS`.
- **Discovery:** an mDNS (DNS-SD) announcement of `_ember-edge._tcp` (`EDGE_SERVICE_TYPE` in
  `droneLink.ts`) on the listen port, named and TXT-tagged `id=<edge server id>`,
  `path=/v1/drone`, for as long as the process runs. A connector whose announcement fails logs it
  and still serves drones given its URL. In `compose.yaml` the connector sits on a Docker network,
  so drones on the LAN only find one run natively (`go run`).
- `GET /healthz`.
- Tasks and the uplink carry `Authorization: Bearer $EMBER_EDGE_KEY`. The drone link is open: a
  drone pairs by being on the network.

## Registering

1. On boot it opens its store and takes its token: `EMBER_EDGE_TOKEN` if set (pre-issued by the
   operator), else the one from an earlier boot, else a new random `edge-<hex>`. The token is the
   edge server's id.
2. It works out the URL edge-manager can reach it at: `EMBER_EDGE_PUBLIC_URL`, else the local
   address that routes to edge-manager plus the listen port.
3. It dials edge-manager and sends `register` with both. It does this again after every reconnect,
   with backoff, so a restarted manager learns it back within seconds.

## Runs

| Event                      | What happens                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_mapping`            | Every connected drone becomes the swarm. The run is saved, then each drone gets the mission with the swarm filled in. Starting the active run again answers with its swarm; another run gets 409 until this one is done. No connected drones is 409. |
| `swarm` from a drone       | Sent to the other drones of the run with `from` set to the sender. `coverage` cells are added to the run's mapped set.                                                                                                                               |
| `stop_mapping`             | The run is `stopping`; every connected drone of the run gets `stop_mapping`.                                                                                                                                                                         |
| A drone reconnects mid-run | It gets `start_mapping` again if this process saw it flying the run. The runtime ignores a start for the run it is flying, so this revives a drone that restarted. A drone that has landed gets nothing, so it does not fly the run twice.           |
| Done                       | Every drone of the run has reported `landed`, or sent no `mission_status` for 2 minutes.                                                                                                                                                             |
| Connector restarts         | The unfinished run is loaded from the store and relayed as before. No drone is sent a start, because their phases are unknown.                                                                                                                       |

## The update

`EdgeUpdate` is a snapshot of state plus the events that are new since the last update:

- **Snapshot:** every paired drone with its `hello`, its latest telemetry and mission status, and
  whether it is connected; plus the current or last run.
- **Deltas:** new `detections` frames and newly mapped `run.newCells`. These stay queued until
  edge-manager has taken an update, so an uplink outage delays them instead of losing them. Up to
  2000 frames are held; past that the oldest are dropped and the drop is logged.
- **Dedupe:**
    - Telemetry no newer than the drone's last `sentAt` is dropped.
    - A detections frame is kept once per drone, `frameId` and `capturedAt`.
    - Coverage cells are a set per run.
- Drone health (battery, mode, phase, position, last seen) goes to the store at most once a second,
  for drones that reported since the last write.

## Store

SQLite (`modernc.org/sqlite`, pure Go, so it cross-compiles to a Mac mini or Pi without cgo).

| Table    | Holds                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`   | `edge_server_id`, the token                                                                                                          |
| `drones` | each drone's last `hello`, when it paired and was last seen, whether it is connected, and its last battery, mode, phase and position |
| `runs`   | each run's mission as sent (swarm included), its state, and when it started and ended                                                |

## Run

```bash
go run ./services/edge-connector/cmd           # from the repo root

# then drones, e.g.
uv run --package ember-drone-runtime drone-runtime run --id drone-1 --edge ws://localhost:8070/v1/drone
```

| Variable                 | Default                 | Meaning                                                                             |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `EMBER_EDGE_ADDR`        | `:8070`                 | Listen address for drones, tasks and health                                         |
| `EMBER_EDGE_MANAGER_URL` | `http://localhost:8060` | edge-manager; the uplink path is added                                              |
| `EMBER_EDGE_PUBLIC_URL`  | derived                 | URL edge-manager reaches this connector at                                          |
| `EMBER_EDGE_TOKEN`       | generated, kept         | This edge server's id                                                               |
| `EMBER_EDGE_KEY`         | unset                   | Shared bearer key. Unset accepts any task and logs a warning (local dev only)       |
| `EMBER_EDGE_DB`          | `edge-connector.db`     | SQLite file                                                                         |
| `EMBER_EDGE_UPDATE_MS`   | `50`                    | Update interval: at least twice the drones' 10 Hz telemetry, so none is overwritten |
