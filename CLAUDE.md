# Ember: operator console

## What this is

Ember is a wildfire watch system for forest and city land managers, built in 24 hours at MHacks 2026.

1. The operator draws a watch zone on a 3D globe.
2. Ember suggests where to put edge servers (drone docks with local networking). The operator adjusts and deploys them.
3. Drones survey the zone on a schedule (every 12 hours by default), then return to their docks to charge.
4. An AI agent turns each survey into a vulnerability report: a heatmap, ranked high-risk sites, photos, and recommended actions.
5. When a fire is found, the agent predicts its spread, plans evacuation routes, and notifies people by severity and distance.
6. Drones are dispatched to suppress the fire.

### Real vs simulated (never blur this, in code or UI)

- Real: the agent and its logic, the dashboard, the map, OpenStreetMap roads and places.
- Simulated: drones, their photos, fires, suppression, residents who receive alerts, and fuel data inside the zone.
- Every simulated thing gets a visible `SIM` tag in the UI. Alerts start with "Demo alert."

## Repo layout

```
agent/    Python package `ember` (already exists). Spread model, evacuation, tools, ASI:One loop, guardrails.
server/   FastAPI app. REST + WebSocket, sim clock, drone sim, survey scheduler. Imports `ember`.
web/      Vite + React + TypeScript operator console with a CesiumJS globe.
```

## Stack

- Web: Vite, React 18, TypeScript (strict), CesiumJS through `vite-plugin-cesium`, Zustand for state. Pick one styling approach (CSS modules or Tailwind) and keep it.
- Map: Google Photorealistic 3D Tiles through CesiumJS when a key is set. Fallback 1: Cesium World Terrain plus satellite imagery from Cesium ion. Fallback 2: OpenStreetMap imagery on the ellipsoid. Always show data attribution. Check the current CesiumJS docs for API names instead of guessing.
- Server: Python 3.11, FastAPI, uvicorn, pydantic, pytest. The `ember` core stays standard-library only.
- Agent reasoning: ASI:One (OpenAI-compatible tool calling) through `agent/ember/brain.py`. The fallback pipeline must keep working with no key.
- Voice: ElevenLabs text to speech, already wired in `agent/ember/channels.py`.

## The existing agent (read agent/README.md before changing it)

- `EmberService` and `ToolContext` with tools: read_detections, read_conditions, predict_spread, plan_evacuation, dispatch_response, notify, log_decision. Chat adds lookup_place and report_detection.
- Guardrails live in code: civilian alerts auto-send only for a drone-confirmed fire at confidence 0.8 or higher. Otherwise an approval request is created. Alert text comes from templates, never from the LLM.
- The agent writes events through a Store: `emit(kind, zone_id, payload)`.
- Tests: `python3 -m unittest discover -s agent/tests`. Keep them passing. Add tests for new logic.

## Events (server to web over WebSocket `/ws`)

Every message: `{ "kind": string, "zone_id": string, "ts": ISO string, "payload": object }`. On connect the server sends a `snapshot` message with current state.

Existing kinds: `log`, `spread`, `route`, `dispatch`, `alert`, `approval_request`, `decision`.

New kinds:

| kind | payload |
| --- | --- |
| `zone` | id, name, polygon `[[lat, lon], ...]`, area_km2 |
| `edge_plan` | servers `[{id, lat, lon, radius_m, status: "pending" or "deployed"}]`, coverage_pct |
| `drone` | id, lat, lon, alt_m, heading_deg, battery_pct, state (`docked`, `charging`, `transit`, `surveying`, `verifying`, `returning`, `suppressing`), dock_id |
| `survey` | id, status (`scheduled`, `running`, `complete`), progress_pct, next_at |
| `capture` | id, survey_id, lat, lon, image_url, kind (`rgb` or `thermal`), simulated |
| `report` | id, survey_id, created_at, summary, mode, cells `[{lat, lon, score}]`, sites, trend |
| `incident` | id, lat, lon, status (`suspected`, `confirmed`, `contained`), confidence |
| `notification` | id, tier (`evacuate`, `prepare`, `watch`), recipients_count, text, audio_url, approved_by |
| `suppression` | incident_id, sorties_done, sorties_planned, containment_pct, treated_cells, simulated |

## Simulation clock

One clock on the server. `speed` is sim seconds per real second. Default 1. Demo mode 360, so 12 hours pass in 2 minutes. Schedules, battery drain, charging, and fire spread all run on sim time. The web shows sim time in the top bar.

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
- After each phase, run the app and look at it. Fix console errors before moving on.
- Python logic gets unit tests. The web app gets a smoke test that loads with the mock event stream.
- Secrets live in gitignored `.env` files. `.env.example` lists every key.
- Assumptions about hardware (drone speed, endurance, charge time, camera swath, payload) live in one config file with comments saying they are assumptions.

## Environment keys

- web: `VITE_SERVER_URL`, `VITE_CESIUM_ION_TOKEN`, `VITE_GOOGLE_MAPS_API_KEY`, `VITE_USE_MOCK`
- server: `ASI1_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `EMBER_SIM_SPEED`, `SPACETIMEDB_URL`, `SPACETIMEDB_DATABASE`, `SPACETIMEDB_TOKEN`
