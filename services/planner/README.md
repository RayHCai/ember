# @ember/planner

Two processes from one package. The **orchestrator** watches the Redis job queue, gathers the watch
zone's context from the api and hands each job to a **worker** over Celery. The worker forecasts fire
spread, recommends attack zones for responders, grades civilian areas by how soon they are hit and
routes each one out. The orchestrator reports status and delivers the result to the api.

Wire shapes: [`packages/contracts/src/planner.ts`](../../packages/contracts/src/planner.ts), mirrored
in [`src/ember_planner/wire.py`](src/ember_planner/wire.py).

## Flow

```
api ──LPUSH PlannerJobRequest──▶ ember:planner:jobs
orchestrator  BLMOVE jobs → ember:planner:processing
              POST /v1/planner/jobs/:jobId/status          { state: gathering }
              GET  /v1/watch-zones/:zoneId/planner-context  → PlannerContext
              Celery task ember_planner.plan(job, context)  on queue "planner"
              POST /v1/planner/jobs/:jobId/status          { state: planning }
worker        plan(job, context) → PlannerResult
orchestrator  POST /v1/planner/jobs/:jobId/result           (accepted = succeeded)
              or POST .../status { state: failed, message }
              LREM processing
```

- A job stays in the processing list until its result is delivered or it is reported failed. On
  start the orchestrator puts anything left there back on the queue, so run **one orchestrator per
  Redis**; scale by adding workers.
- Result delivery retries 5xx and network errors with backoff, 5 attempts. A 4xx fails the job.
- A worker that has not answered after `EMBER_PLANNER_JOB_TIMEOUT_S` is revoked and the job fails.
- Malformed queue messages are dropped; if they carry a `jobId` the api gets a `failed` status.
- Calls to the api carry `Authorization: Bearer <EMBER_PLANNER_KEY>`.

## What the worker computes

Everything is on one planning grid: the extent of the zone, risk zones, detections, civilian
areas, shelters and stations plus 1.5 km, at 30 m cells or coarser so it stays under 40,000 cells.
A run takes well under a second on a laptop.

| Output             | How                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fireSpread`       | Minimum travel time (Dijkstra) over a 16-neighbour grid from every `on_fire` zone and confident detection, each started at its age. Spread rate = fuel base rate × dryness (temperature, humidity) × elliptical wind factor × slope factor. Output: arrival minutes per cell, perimeter isochrones every `bandMin`, the centroid track and the heading. |
| `attackZones`      | The forecast is a tree (each cell burns from one parent). A cell's value is everything downstream of it, people weighted above forest. Candidates must be reachable from a station (roads, then on foot) 15 min before the fire, and slow fronts beat fast ones. Top-N with a 400 m minimum separation; drop site is the nearest road point. With stations and roads, `approach` is the fastest road path from the nearest-in-time station (walk-on, then roads) to the drop site: `stationId`, `path`, `roadIds`, `etaMin` and `arrivesFromDeg`, the bearing the crew comes from.              |
| `civilianImpacts`  | Earliest arrival over each area's cells. `gradient` is 1 for burning now, 0 for not reached in the horizon. Severity: `immediate` ≤ 60 min, `warning` ≤ 120, `watch` later, `clear` never.                                                                                                                                                               |
| `evacuationRoutes` | For every impacted area, a time-aware search over the road network to the nearest safe zone: a node is passable only if the evacuee reaches it `safetyMarginMin` before the fire, and nodes the fire reaches soon after cost more. No safe zones: road exits at the planning edge. No roads: cross-country over the grid. `roadIds` lists the roads a route uses, in order. `alternate` is the same search rerun with every road of the primary removed; null when there is none.                                  |
| `sectorRisks`      | Square sectors of `sectorSizeM` over the zone boundary, clipped to it and numbered `S1`, `S2`, ... row by row from the north-west. Score = 0.5 × spread potential (fastest head-fire rate across burnable cells under today's weather and slope, against 20 m/min) + 0.3 × ignition (nearness to observed fire, decaying over 1.5 km, floor 0.1) + 0.2 × exposure (civilians within 1.5 km, against 2,000). Bands: low < 0.3, moderate < 0.5, high < 0.7, else extreme. Highest score first, with up to four factual `drivers`. |

Road `state` shapes every route over the network: `blocked` roads are not in the network, so no
route or approach uses them; `uncertain` roads are travelled at half speed. Each is listed in
`assumptions`. A context whose roads are all blocked is treated as having no road network.

Missing context degrades rather than fails, and each fallback is listed in `assumptions`: no
terrain means flat ground, and no fuel map means timber inside the zone, shrub outside and urban in
civilian areas. With no weather the wind is calm. With no fire seen, at-risk areas are ignited as a
what-if.

This is a fast screening model with Rothermel-shaped factors, not a calibrated simulator (no
spotting, no fuel moisture by time of day, no suppression). Constants are at the top of
`landscape.py`, `spread.py`, `response.py`, `civilians.py` and `sectors.py`.

### Job options (`PlannerJobRequest.options`)

| Option               | Default |
| -------------------- | ------- |
| `horizonMin`         | 180     |
| `bandMin`            | 30      |
| `attackZoneCount`    | 5       |
| `evacuationDelayMin` | 10      |
| `safetyMarginMin`    | 15      |
| `sectorSizeM`        | 1000    |

## Run

```
docker compose up -d redis
uv run --package ember-planner ember-planner worker          # Windows and macOS default to --pool solo
uv run --package ember-planner ember-planner orchestrator
uv run --package ember-planner ember-planner plan context.json --out result.json   # offline, no Redis
```

Both expose `GET /healthz`: the orchestrator `{ service, ok, inFlight }`, the worker `{ service, ok }`
once Celery is ready.

| Variable                          | Default                    | Meaning                          |
| --------------------------------- | -------------------------- | -------------------------------- |
| `EMBER_REDIS_URL`                 | `redis://localhost:6379/0` | Job queue, Celery broker/results |
| `EMBER_API_URL`                   | `http://localhost:4001`    | api base URL                     |
| `EMBER_PLANNER_KEY`               | none; orchestrator needs it | Bearer token for the api         |
| `EMBER_PLANNER_MAX_IN_FLIGHT`     | `4`                        | Jobs dispatched at once          |
| `EMBER_PLANNER_JOB_TIMEOUT_S`     | `600`                      | Worker deadline per job          |
| `EMBER_PLANNER_ORCHESTRATOR_PORT` | `4007`                     | Orchestrator health port         |
| `EMBER_PLANNER_WORKER_PORT`       | `4008`                     | Worker health port               |
