# 0007: Planner orchestrator and workers

**Status:** in-progress
**Touches:** services/planner, packages/contracts, docs/architecture.md

## Goal

An operator (or a schedule, or a detection) asks for a plan on a watch zone. The api queues a job;
the planner gathers the zone's context, forecasts where the fire goes, recommends where responders
should fight it, grades civilian areas by how soon they are hit, routes each one out, and delivers
all of it back to the api.

## Plan

- [x] Contract `packages/contracts/src/planner.ts`: queue keys, Celery queue and task name, api
      paths, `PlannerJobRequest`, `PlannerContext`, `PlannerJobStatusUpdate`, `PlannerResult`.
      Python mirror in `ember_planner/wire.py` (pydantic). No Go side speaks it.
- [x] Worker: `landscape.py` (planning grid, fuel, elevation, ignitions), `spread.py`
      (minimum-travel-time spread), `forecast.py` (isochrones, track), `response.py` (attack zones),
      `civilians.py` (impacts, time-aware evacuation), `network.py` (roads noded at junctions, or
      grid), `plan.py` (pure entry), `worker.py` (Celery task).
- [x] Orchestrator: `orchestrator.py` (Redis BLMOVE queue with a processing list, api client,
      Celery dispatcher, timeouts, result delivery retries), `health.py`, `cli.py`.
- [ ] api: `planner_jobs` table, `POST /v1/watch-zones/:zoneId/planner-jobs` that LPUSHes a
      `PlannerJobRequest`, and the three planner routes in `planner.ts` behind `EMBER_PLANNER_KEY`.
      Blocked on watch zones, risk zones, roads and civilian areas existing in the api.
- [ ] Context sources in the api: terrain (elevation + fuel) and roads for a zone, e.g. from Demo
      Data's Lahaina fuels/buildings or OSM; weather from a feed.
- [ ] Add the `EMBER_PLANNER_*` variables (see the planner README) to `.env.example`.
- [ ] Run end to end against a live Redis (`docker compose up -d redis`, worker, orchestrator, an api
      stub) and against the Lahaina scenario.
- [ ] Dashboard overlay and civilian-map: draw `isochrones`, `attackZones` circles,
      `civilianImpacts` gradient and `evacuationRoutes`.

## Decisions

- One package, two processes (`ember-planner orchestrator`, `ember-planner worker`), matching
  `docs/architecture.md`'s single planner service. They share the wire models and the Celery app
  config; deployed separately. Rejected: two packages, which would duplicate the wire mirror.
- The orchestrator pulls the context from the api over HTTP rather than the api packing it into the
  queue message. Keeps queue messages small, lets the api build context lazily, and the planner never
  touches the api's tables. Rejected: the planner reading Postgres directly (boundary violation).
- The orchestrator dispatches by task name (`send_task`) and polls results from the Celery result
  backend in its own loop, so it holds every in-flight job and reports each outcome itself.
  Rejected: Celery callbacks that post to the api from the worker (two processes would then talk
  to the api, and a failed worker could not report).
- One orchestrator per Redis: on start it requeues whatever is left in the processing list. Scale
  out with workers.
- Spread is a minimum-travel-time model (Dijkstra over a 16-neighbour grid) with Rothermel-shaped
  wind, slope and dryness factors. It runs in well under a second and yields a spread tree, which
  is what attack-zone value (protected downstream area and people) is computed from. Rejected for
  now: a cellular automaton (stochastic, slower, no tree) and FARSITE-class simulators (heavy
  inputs we do not have).
- Evacuation is a time-aware label-setting search: a node is closed if the fire reaches it less
  than the safety margin after the evacuee would. Routes through two fires closing on each other
  are therefore impossible, not just discouraged.
- Missing context degrades and is listed in `assumptions`, rather than failing the job.

## Log

- 2026-10-03: Contract, worker and orchestrator written. planner: 45 tests, ruff and mypy strict
  clean; contracts typecheck and build. Synthetic zone (3 km, 12 m/s west wind): a run takes about
  0.1 s with roads and 0.6 s cross-country. The fire heads east and reaches the town 2 km downwind
  at 88 min. The top attack zone sits between fire and town. The town routes north to its shelter
  with 90 min clearance; with Main St burning it gets no route, or the east exit when one exists.
    - Not run: a live Redis (no Docker daemon on this machine). The Celery task ran in-process
      (`apply`); the queue loop ran against fakes and an httpx mock api.
    - Next: the api side (see Plan), then a Lahaina context from Demo Data.
