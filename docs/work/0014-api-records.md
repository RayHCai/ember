# 0014: API records

**Status:** in-progress
**Touches:** services/api, packages/contracts, compose.yaml, docs/architecture.md

## Goal

The api stores the edge plane's records in Postgres (edge servers, drones, watch zones, mapping-run
coverage, drone detections, planner jobs) and serves CRUD routes for them, plus the three routes
the planner orchestrator already calls, so edge-manager, drone-info and the planner can read and
write through it.

## Plan

- [x] Prisma models and one additive migration (`20261005000000_registry_detections_planner`):
      `watch_zones`, `edge_servers`, `drones`, `mapping_runs`, `detection_frames`, `detections`,
      `planner_jobs`
- [x] Record shapes and paths in `packages/contracts/src/api.ts`
- [x] Routes in `services/api/src/routes/`: watch zones, edge servers, drones, mapping runs,
      detections, planner jobs; planner context, status and result
- [x] Bearer keys (`EMBER_EDGE_KEY`, `EMBER_PLANNER_KEY`) and the Redis planner queue
- [x] Unit tests (stubbed Prisma); end-to-end run against a throwaway Postgres and Redis with the real
      planner orchestrator and worker (job queued → succeeded)
- [ ] Apply the migration to the shared database (`pnpm --filter @ember/api db:deploy`): purely
      additive, but it is production, so an operator runs it
- [x] edge-manager calls the api: `PUT /v1/edge-servers/:id` on `register`, `PUT /v1/drones/:id`
      for each drone in an update, `PUT /v1/mapping-runs/...` with `update.run`, and
      `POST /v1/detections` with `update.detections`. Add the Go mirror of `api.ts` in
      `internal/` and the channel in `docs/architecture.md` in the same commit (0015)
- [x] Operator auth for the dashboard (0015); the operator-agent still calls with a service key
- [x] Store what the planner context leaves empty: risk zones, weather, civilian areas, roads, safe
      zones and stations (0015). Terrain stays empty

## Decisions

- Edge server id is the connector's token and `url` is what it registers with, as in `EdgeRegister`.
  Zone, location and radius are optional columns because the api builds `StartMappingTask` from
  them. Their `PUT` keeps omitted fields, so a connector re-registering never clears them.
- Geometry is JSONB `LatLng[]`, not PostGIS columns: Prisma has no geometry type (every write
  would be raw SQL) and the shared database may not have the extension. A generated geometry
  column can be added later without a rewrite.
- A mapping run is keyed by (run, edge server), matching `EdgeRun`; `newCells` accumulate into a
  sorted `int[]` per row.
- Detection frames are unique on (drone, `frameId`, `capturedAt`), the connector's own dedupe key,
  so retried batches are idempotent. `droneId` and `edgeServerId` are not foreign keys: a frame is
  an observation and outlives its drone's registration. Its zone is fixed when it arrives.
- Deleting a zone deletes its runs and planner jobs, and leaves edge servers and frames with no zone.
- Planner job creation refuses (503) when no queue is configured instead of storing a job nothing
  will run.

## Log

- 2026-10-04: edge-manager recording, operator auth and the planner context's data landed with
  0015; only deploying the migrations to the shared database is left.
- 2026-10-03: Built the routes, migration, contracts and tests. Verified on a fresh PostGIS
  container: all four migrations apply, `migrate diff` shows no drift, every CRUD route works over
  HTTP, and a planner job ran through the real orchestrator and worker. Next: deploy the migration,
  then wire edge-manager.
