# Ember: operator console

## What this is

Ember is a wildfire watch system for forest and city land managers, built in 24 hours at MHacks 2026. It ships as a desktop application (Tauri), not a website.

**This repo is the operator console only, and it runs on built-in dummy data.** There is no backend and no Python here. The drone, survey, report, fire and alert logic belongs to a separate service on another device; do not build it here. Until that service exists, the console's dummy backend (`web/src/data/demo/`) answers every operator action and plays the demo story, emitting the same events the service will send (see "Events"). Setting `VITE_SERVER_URL` switches the console to a real service instead.

1. The operator draws a watch zone on a 3D globe.
2. Ember suggests where to put edge servers (drone docks with local networking). The operator adjusts and deploys them.
3. Drones survey the zone on a schedule (every 12 hours by default), then return to their docks to charge.
4. An AI agent turns each survey into a vulnerability report: a heatmap, ranked high-risk sites, photos, and recommended actions.
5. When a fire is found, the agent predicts its spread, plans evacuation routes, and notifies people by severity and distance.
6. Drones are dispatched to suppress the fire.

### Real vs simulated (never blur this, in code or UI)

- Real: the dashboard and the map imagery.
- Simulated (dummy data in this build): zones' roads, towns and shelters, drones, their photos, reports, fires, suppression, residents who receive alerts, and the agent's runs and replies.
- Every simulated thing gets a visible `SIM` tag in the UI. Alerts start with "Demo alert."

## Repo layout

```
web/                 Vite + React + TypeScript operator console with a CesiumJS globe.
web/src/data/demo/   The dummy backend: scenario data and the demo player.
web/src/resident/    The resident alert page for phones (/alert).
web/src-tauri/       Tauri 2 desktop shell (Rust): the window, app log, bundling.
```

Run it with `make app` (desktop app), `make dev` (console in a browser), `make phones` (resident page on the local network), `make bundle` (builds Ember.app) and `make test`.

## Stack

- Web: Vite, React 18, TypeScript (strict), CesiumJS through `vite-plugin-cesium`, Zustand for state. Pick one styling approach (CSS modules or Tailwind) and keep it.
- Map: Google Photorealistic 3D Tiles through CesiumJS when a key is set. Fallback 1: Cesium World Terrain plus satellite imagery from Cesium ion. Fallback 2: OpenStreetMap imagery on the ellipsoid. Always show data attribution. Check the current CesiumJS docs for API names instead of guessing.
- Desktop: Tauri 2. The operator console is the app's only window; there is nothing else to start. The resident alert page is the one page meant for a phone browser.
- Tests: Playwright browser tests in `web/tests` (`make test`), all on the dummy data.

## The logic service (not in this repo)

- It owns the agent (spread, evacuation, tiers, guardrails, ASI:One, ElevenLabs), the drones and the surveys.
- Its guardrail, which the dummy data mirrors: civilian alerts auto-send only for a drone-confirmed fire at confidence 0.8 or higher; otherwise an approval request is created.
- It connects by sending the events below over a WebSocket at `VITE_SERVER_URL` + `/ws`, and by answering the operator actions listed after them.

## Events (logic service, or the dummy backend, to the console)

Every message: `{ "kind": string, "zone_id": string, "ts": ISO string, "payload": object }`. On connect the service sends a `snapshot` message with current state.

Existing kinds: `log`, `spread`, `route`, `dispatch`, `alert`, `approval_request`, `decision`.

New kinds:

| kind | payload |
| --- | --- |
| `sim` | sim_time, speed, paused (zone_id `*`; sent when the clock changes) |
| `zone` | id, name, polygon `[[lat, lon], ...]`, area_km2 |
| `zone_map` | source (`osm`, `cache`, `synthetic`), note, roads, communities, shelters, grid (100 m cells, `in_zone` mask), elevation (`terrain` or `flat`) |
| `zone_removed` | id |
| `edge_plan` | servers `[{id, lat, lon, radius_m, status: "pending" or "deployed", near_road}]`, coverage_pct |
| `drone` | id, lat, lon, alt_m, heading_deg, battery_pct, state (`docked`, `charging`, `transit`, `surveying`, `verifying`, `returning`, `suppressing`), dock_id |
| `survey` | id, status (`scheduled`, `running`, `complete`), progress_pct, next_at |
| `capture` | id, survey_id, lat, lon, image_url, kind (`rgb` or `thermal`), simulated |
| `report` | id, survey_id, created_at, summary, mode, cells `[{lat, lon, score}]`, sites, trend |
| `incident` | id, lat, lon, status (`suspected`, `confirmed`, `contained`), confidence |
| `notification` | id, tier (`evacuate`, `prepare`, `watch`), recipients_count, text, audio_url, approved_by |
| `suppression` | incident_id, sorties_done, sorties_planned, containment_pct, treated_cells `[[lat, lon], ...]`, simulated |
| `fleet` | drones `[drone payloads]` (replaces a zone's fleet when its docks change) |
| `survey_cells` | survey_id, cells `[grid cell indexes]`, reset (true on a new survey) |
| `recipients` | incident_id, residents `[{id, lat, lon, tier or null, community}]`, simulated |
| `agent_run` | run_id, trigger, mode (`asi1`, `fallback`, `policy`) |

Fields the console reads from the agent kinds:

| kind | payload |
| --- | --- |
| `log` | message, level, source, and for a step of an agent run: run_id, tool, args, result |
| `decision` | summary, actions, run_id, approval_id (set when it resolves an approval) |
| `approval_request` | id, reason, tier, texts, recipients_count, incident_id |
| `spread` | incident_id, cell_m, cells `[[lat, lon, arrival_min], ...]`, head_bearing_deg, horizon_min, communities `[{name, lat, lon, arrival_min}]`, with_suppression |
| `route` | id, incident_id, community, shelter, path `[[lat, lon], ...]`, distance_km, eta_min |
| `dispatch`, `alert` | message, incident_id, drone_ids |

Operator actions the console sends to a service: `POST /zones`, `DELETE /zones/{id}`, `POST /zones/{id}/edge-plan`, `POST /zones/{id}/edge-servers`, `PUT /zones/{id}/shelters`, `POST /zones/{id}/surveys`, `POST /zones/{id}/incidents` (test fire), `POST /incidents/{id}/suppression`, `POST /approvals/{id}/approve`, `POST /approvals/{id}/hold`, `POST /agent/chat` `{zone_id, text}` returning `{reply}`, `POST /sim/speed`, `POST /sim/pause`, `POST /sim/resume`. With dummy data, the dummy backend answers all of them.

## Simulation clock

One sim clock, shown in the top bar. `speed` is sim seconds per real second; the dummy data runs at 360, so 12 hours pass in 2 minutes. The speed and pause buttons drive it.

## Design system

Brief: a tactical "god's eye" operator console, like a satellite intelligence UI. Black field, cyan instrument chrome, fire in red. The one memorable thing is the 3D globe with the vulnerability heatmap and the thermal view. Everything else stays quiet.

| Token | Value | Use |
| --- | --- | --- |
| void | `#03070A` | page and globe background |
| panel | `rgba(6, 18, 22, 0.78)`, border `#123540` | floating panels, with backdrop blur |
| signal | `#3FE0FF` | HUD chrome, selection, data lines, edge server rings |
| text | `#E3F6FB` | primary text |
| muted | `#6E8D96` | secondary text |
| warn | `#FFB020` | elevated risk, "prepare" tier |
| heat | `#FF3B2F` | fire, "evacuate" tier |

- Type: "Chakra Petch" for the product name, panel titles, and HUD labels. "IBM Plex Mono" for coordinates, telemetry, and timestamps. Sentence case everywhere except the product name.
- Panels float over the globe. The globe is never boxed in.
- Warn and heat colors mean danger only. Never use them for decoration.
- Map filters: Normal, Thermal, Night, CRT, built as Cesium post-process stages.
- Motion only when something happens: survey sweep, new incident, alert sent, report fly-through. Respect `prefers-reduced-motion`.
- Copy: plain verbs. Buttons say what they do: "Run survey", "Deploy edge servers", "Approve alerts", "Dispatch drones".
- Do not copy the name, logo, or classification banners of any reference UI.
- No em dashes in UI copy.

## Working rules

- Start each phase in plan mode, get the plan approved, then build. Commit at the end of each phase.
- Never fake an integration silently. If a key is missing or a service is down, show a visible badge such as "Offline: using fallback map" and keep working.
- After each phase, run the app (`make app`) and look at it. Fix console errors before moving on. In the desktop app, webview errors are forwarded to the app log.
- No Python and no extra services: the app runs on its dummy data alone.
- Browser tests cover each feature on the dummy data, and assert no console errors.
- Secrets live in gitignored `.env` files. `.env.example` lists every key.

## Environment keys

- web: `VITE_SERVER_URL` (optional; empty means dummy data), `VITE_CESIUM_ION_TOKEN`, `VITE_GOOGLE_MAPS_API_KEY`
