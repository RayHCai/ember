# Ember: Claude Code prompts for the operator console

## How to use this

1. Make a repo. Put `CLAUDE.md` at the root. Copy the `ember-agent` folder from the earlier zip into `agent/`.
2. Run `claude` in the repo root. Claude Code reads `CLAUDE.md` at the start of every session, so each prompt below can stay short.
3. For each prompt: switch to plan mode (Shift+Tab, or `/plan`), paste the prompt, read the plan, fix anything wrong, then let it build.
4. When a prompt is done and checked, commit, then run `/clear` before the next one. `CLAUDE.md` survives `/clear`.
5. Order matters. Prompts 0 to 6 and 9 are the core. 7 and 8 are strong extras. 10 is optional.

If time runs short, cut in this order: Prompt 10, the voice part of Prompt 8, the civilian page in Prompt 6, then Prompt 7.

---

## Prompt 0: Scaffold

```
Read CLAUDE.md and agent/README.md first.

Set up the monorepo described in CLAUDE.md. Do not build features yet.

1. agent/: add a minimal pyproject.toml so the `ember` package installs with `pip install -e agent`. Do not change its code. Confirm the existing unit tests pass.
2. server/: FastAPI app with GET /health returning {"ok": true}, uvicorn entry point, requirements.txt, pytest config, and one test for /health.
3. web/: Vite + React + TypeScript (strict) app with CesiumJS through vite-plugin-cesium and Zustand. It renders a full-window Cesium viewer with every default widget turned off (no timeline, animation, base layer picker, geocoder, home, help, scene mode picker, fullscreen, navigation help). Black page background.
4. Root: a Makefile (or package.json scripts) where `make dev` runs server and web together, `make test` runs agent, server, and web tests.
5. .env.example for web and server with every key listed in CLAUDE.md, and .gitignore entries for .env files, node_modules, caches, and out/.

Done when: agent tests pass, /health returns ok, and the web app shows a blank globe with no console errors. Tell me the exact commands to run.
```

---

## Prompt 1: Globe and HUD shell

```
Build the visual shell of the operator console. Follow the design system in CLAUDE.md exactly.

Map:
- Load Google Photorealistic 3D Tiles through CesiumJS when VITE_GOOGLE_MAPS_API_KEY or VITE_CESIUM_ION_TOKEN is set. Look up the current CesiumJS API for this instead of guessing function names.
- Fallback chain: Cesium World Terrain with ion imagery, then OpenStreetMap imagery on the ellipsoid. Show a small badge naming which map is active, and keep attribution visible in the bottom left, styled to match the HUD.

Layout (panels float over the globe, which fills the window):

+----------------------------------------------------------------------+
| EMBER   zone name, status            sim clock  speed   filter       |
|                                                                      |
| Layers                          GLOBE                      Agent     |
|  toggles                                                   log       |
|                                                            approvals |
|                                                            chat      |
| cursor lat/lon, MGRS, altitude                                       |
|          [ location search  |  zone presets  |  demo controls ]      |
+----------------------------------------------------------------------+

- Top bar: product name, active zone and status, sim clock, sim speed, connection dot, filter switch.
- Left: Layers panel with toggles for edge servers, coverage, drones, survey heatmap, vulnerable sites, fire spread, routes, recipients, suppression. Wire the toggles to the store even though the layers are empty for now.
- Right: Agent panel with three tabs (Log, Approvals, Chat), empty states that tell the operator what to do next.
- Bottom left: cursor coordinates in lat/lon and MGRS (use the `mgrs` npm package), camera altitude.
- Bottom center: location search (use Cesium's geocoder service or Nominatim), zone presets, demo controls placeholder.

Filters as Cesium PostProcessStage shaders, switchable from the top bar and keys 1 to 4:
- Normal: no stage.
- Thermal: luminance mapped to a false-color ramp (black, deep purple, red, orange, yellow, white).
- Night: green phosphor, light grain, vignette.
- CRT: scanlines, slight chromatic offset, vignette.

Opening moment: start on a whole-earth view, then fly to the active zone (or a default location) once. This is the one orchestrated animation on load. Respect prefers-reduced-motion.

Mock data: create web/src/data/mockStream.ts that emits sample events of every kind listed in CLAUDE.md on a timer, enabled with VITE_USE_MOCK=1. The UI must be buildable against this before the server exists.

Done when: tiles render (or a labeled fallback), filters switch with keys 1 to 4, panels are readable over bright terrain, there are no console errors, and the globe stays smooth while panning. Take screenshots of each filter and fix anything that looks off before finishing.
```

---

## Prompt 2: Server, event stream, sim clock

```
Build the server backbone and connect the web app to it.

Server:
1. An in-process event bus (asyncio pub/sub) and WebSocket endpoint /ws. On connect, send one `snapshot` message with current state (zones, edge servers, drones, latest survey and report, active incidents, pending approvals, recent log), then stream every event.
2. A `BusStore` class that subclasses `ember.store.Store`, so every event the existing agent emits (log, spread, route, dispatch, alert, approval_request, decision) goes onto the bus unchanged. Detections are added through it too.
3. A sim clock: sim time, speed (sim seconds per real second), pause and resume. Endpoints: GET /sim, POST /sim/speed, POST /sim/pause, POST /sim/resume. Speed defaults to EMBER_SIM_SPEED or 1. Every timed process added later must use this clock.
4. One EmberService instance per zone, created when a zone is created. Keep the existing guardrails exactly as they are.
5. Stub routes that return 501 for now: zones, edge plan, deploy, surveys, incidents, approvals, suppression, agent chat. Later prompts fill them in.
6. pytest tests: the snapshot arrives first on connect, an emitted agent event reaches a WebSocket client, sim speed changes the clock rate.

Web:
1. A `useEventStream` hook with automatic reconnect and a visible connection state in the top bar.
2. A Zustand store that applies the snapshot, then each event by kind. Keep telemetry (`drone`) in a separate fast path so it does not re-render the whole app.
3. Switch between mock and live with VITE_USE_MOCK.
4. The top bar shows sim time and speed, with buttons for 1x, 60x, and 360x.

Done when: with the server running, the web app connects, shows sim time ticking, and reconnects after a server restart.
```

---

## Prompt 3: Watch zones and edge server placement

```
Build zone creation and edge server placement, end to end.

Web, zone drawing:
- "New zone" mode: click on the globe to place vertices (use scene.pickPosition on 3D tiles, falling back to the ellipsoid). Show vertices, the edges between them, and a closing line back to the first point. Double-click or click the first vertex to close. Fill with signal color at low opacity.
- Vertices can be dragged after closing. Show area in km2 live. Ask for a zone name, then "Save zone".
- Zones list in the Layers panel. Selecting a zone flies to it.

Server, region building (POST /zones):
- Extend `ember.region.Region` so a region can be built from a polygon, without breaking the existing synthetic demo region or its tests.
- Grid: 100 m cells over the polygon's bounding box. Cells outside the polygon are marked out of zone and never burn or get scored.
- Fuel: procedural, seeded by zone id, same fuel types as today. Mark the region as synthetic fuel so the UI shows SIM on the fuel and heatmap layers.
- Roads and communities: fetch from the OpenStreetMap Overpass API for the bounding box plus a 2 km margin. Roads: highway types from primary down to residential and unclassified. Communities: place=town, village, hamlet, plus clusters of residential buildings if no places are found. Cache every Overpass response under server/cache/ keyed by bounding box, so the demo works on bad Wi-Fi. If Overpass fails and there is no cache, fall back to the synthetic road lattice and emit a log event saying so.
- Shelters: suggest the two nearest schools or community centres outside the polygon. The operator can move or add shelters by clicking.
- Elevation: optional. If easy, the web app samples terrain heights for the grid with sampleTerrainMostDetailed and sends them with the zone. Otherwise use flat elevation and say so in the log.

Server, edge plan (POST /zones/{id}/edge-plan):
- Candidate points every 250 m inside the polygon. Prefer points within 200 m of a road (maintenance access).
- Greedy coverage with a radius from config (default 1500 m): repeatedly pick the candidate covering the most uncovered in-zone cells, until coverage reaches 90 percent or the max server count is hit.
- Return pending servers and coverage_pct as an `edge_plan` event. Unit test the greedy cover.
- POST /zones/{id}/edge-servers: accept an edited list (operator moved, added, or removed servers), recompute coverage, mark them deployed.

Web, edge servers:
- "Suggest edge servers" shows pending servers as icons with pulsing radius rings. They can be dragged, removed, or added by clicking.
- Coverage percentage updates live as servers move. Cells outside coverage are shaded gray.
- "Deploy edge servers" commits them. Deployed rings stop pulsing.
- Roads, communities, and shelters appear as a layer.

Done when: I can draw a zone over a real forested area, get suggested edge servers, adjust them, deploy them, and see coverage percent. Roads and communities come from OpenStreetMap, or a visible badge says the fallback was used.
```

---

## Prompt 4: Drone fleet and scheduled surveys

```
Build the simulated drone fleet and the 12-hour survey cycle. All hardware numbers are assumptions: put them in server/config.py with comments.

Defaults: 2 drones per edge server dock, cruise 12 m/s, endurance 25 minutes, 20 percent battery reserve for return, charge time 60 minutes, camera swath 100 m, survey altitude 120 m, survey interval 12 hours.

Survey planning (server, unit tested):
- Assign each in-zone cell to its nearest deployed dock.
- For each dock, plan back-and-forth survey lines over its cells, spaced by the camera swath.
- Split lines into sorties that fit battery with the reserve, including transit to and from the dock.
- Schedule sorties across the dock's drones. A drone charges at its dock between sorties.
- A survey runs on the interval, plus "Run survey now". Emit `survey` events with progress and the next scheduled time.

Simulation (server):
- Drones move along their sortie paths on sim time. Emit `drone` telemetry about 4 times per real second per drone, throttled at high sim speeds.
- Every cell a drone covers gets an observation: a dryness index derived from fuel moisture plus noise, and the fuel class. Rarely, a seeded thermal anomaly appears. A debug endpoint can force one at a given point for the demo.
- Captures: record a capture point at each anomaly and at intervals along the path, as `capture` events with no image yet. Real photos can replace them later through POST /captures/{id}/upload (for the Raspberry Pi).
- After the last sortie, every drone returns and charges. Report the percentage of zone cells observed and which cells were missed.

Web:
- Drones as billboards or small models with heading, short fading trails, and a state color. Docks show ready or charging and how many drones are home.
- Survey progress bar and next-survey countdown in the top bar.
- Click a drone to open an inspector with battery, state, current sortie, and dock.
- Observed cells fill in lightly as drones pass, so the sweep is visible.

Done when: at 360x speed, a full survey runs, drones fly, return, and charge, at least 95 percent of the zone is observed (or the missed cells are listed), and the next survey is scheduled 12 sim hours later.
```

---

## Prompt 5: Vulnerability report

```
Build the agent's vulnerability report and the report view. This is the showcase screen.

Scoring (agent/ember/vulnerability.py, standard library only, unit tested):
- Per in-zone cell, compute components from 0 to 1: fuel load (by fuel type), dryness (observed dryness index, else estimated fuel moisture), slope (from elevation if present), wind alignment (the cell is upwind of a community within 3 km under current wind), exposure (closeness to communities and roads), and anomaly (thermal flag).
- Score 0 to 100 as a weighted sum, with weights in one config dict. Keep the components so the report can explain each score.

Sites:
- Group connected cells with score 70 or higher (if fewer than 3 groups, use the top 10 percent instead). Rank groups by peak score times area.
- For the top 5 sites: centroid, area in hectares, peak score, the top two drivers in plain words, nearest community and distance, and one recommended action from rules. Examples: anomaly present means "Send a drone to verify now". High dryness near homes means "Prioritize fuel clearing and survey again in 6 hours".
- Trend versus the previous report: change in average score, new sites, sites that dropped off.

Agent:
- New tool `build_vulnerability_report(survey_id)` that runs after every survey and emits a `report` event.
- ASI:One writes an 80-word-max summary from the structured data only. Check in code that every number in the summary appears in the input data. If the check fails or ASI:One is unavailable, use a template summary. The report records which mode wrote it.
- Keep it working with no ASI:One key.

Web report view:
- Opens automatically when a report arrives, with a toast to dismiss it.
- Heatmap: draw cell scores as one image draped over the zone (for example a canvas texture with a single-tile imagery provider, or one ground primitive with per-instance colors). Do not create one entity per cell. The color ramp goes from transparent through warn to heat. Show a SIM tag because fuel data is synthetic.
- Ranked sites list on the right: score, area, drivers, nearest community, action, trend arrow.
- Selecting a site plays the signature moment: fly to an oblique view, slow orbit, switch to the Thermal filter, and show its capture photo.
- Photos: if a capture has no real image, make a simulated capture from the 3D map. Fly the camera to an oblique view of the site, wait until the tileset reports tiles loaded, grab the canvas (enable preserveDrawingBuffer in the viewer's WebGL context options), upload it to the server, and label it "Simulated capture from 3D map". Real Pi photos replace these when uploaded.
- When the report first opens, sweep from the zone overview into site 1.
- "Download report": a print stylesheet that produces a clean PDF with the map snapshot, summary, sites table, and photos.

Done when: after a survey, the report opens on its own, the heatmap and ranked sites appear, each site has a photo and a reason, and the summary shows whether ASI:One or the template wrote it.
```

---

## Prompt 6: Fire incidents and notifications by severity and distance

```
Build the incident flow, from first sign of fire to people being notified.

Triggers:
- A thermal anomaly found during a survey.
- "Start test fire" (labeled SIM) in demo controls: click a point on the globe.

Verification:
- The nearest docked drone with enough battery flies to the point (state `verifying`). On arrival it reports a detection with a confidence value (sim). Emit `incident` as suspected, then confirmed or dismissed.
- Pass the detection to the zone's EmberService, so the existing agent loop runs: conditions, spread, routes, handoff, notify, decision. Keep every existing guardrail.

Spread on the map:
- Animate the `spread` cells by arrival time with a scrubber from now to +6 hours. Show the fire front, the head direction arrow, and community arrival times.
- Draw `route` paths to shelters.

Recipients (all SIM):
- Generate synthetic residents around OpenStreetMap communities and residential areas, about 300 points, weighted by place size. Label them SIM.
- "Add my phone": a resident page can register a real device with its location (see below).

Tiering (agent/ember/notify_tiers.py, unit tested, constants in config):
- For each recipient, find the predicted fire arrival time at their cell and their distance to the current fire.
- evacuate: arrival within 90 minutes or distance within 1.5 km.
- prepare: arrival within 180 minutes or distance within 4 km.
- watch: distance within 10 km.
- otherwise no message.
- Message templates per tier. The evacuate message includes the route and shelter from plan_evacuation for the nearest road point. All messages start with "Demo alert." ElevenLabs audio is generated once per community for the evacuate tier, not once per person.
- Add an agent tool `notify_by_proximity` that uses this, and route it through the same approval guardrail: auto-send only for a drone-confirmed fire at 0.8 or higher, otherwise create an approval request.

Web:
- Recipients layer as dots colored by tier (heat, warn, signal), with counts per tier in the Agent panel.
- Approval card with the exact texts, the reason it was held, and "Approve alerts" and "Hold" buttons.
- Phone preview: click anywhere on the map to see what a resident at that spot would receive, including tier, text, route, and audio.
- Notification history with timestamps and who approved.

Resident page (/alert, mobile layout):
- Register a location with the browser's geolocation or by tapping a map.
- Receive alerts over the WebSocket. Show the tier, text, route, and shelter. Play audio after a "Tap to enable sound" button, since browsers block autoplay.
- Use the browser Notification API when permission is granted. Note in the README that true background push needs a service worker and HTTPS, which is out of scope unless time allows.

Done when: a test fire is verified by a drone, the spread animates, residents are tiered, alerts go out (or wait for approval when confidence is low), and a real phone on the resident page receives its alert.
```

---

## Prompt 7: Suppression mission (simulated)

```
Build the drone suppression mission. It is simulated, and the UI must say so clearly.

Agent tool `dispatch_suppression(incident_id)` (unit tested):
- Assign available drones from the docks nearest the fire.
- Target cells: the band the fire is predicted to reach 20 to 60 minutes from now, along the head direction.
- Each sortie treats a fixed number of cells (a payload assumption in config). Treated cells burn at 10 percent of their normal rate.
- After each sortie, rerun the spread prediction with the treated cells.
- Containment percent = 1 minus (predicted 6-hour burn area now divided by predicted 6-hour burn area at dispatch).
- Mark the incident contained when containment reaches 80 percent, or when the predicted area stops growing for one sim hour.
- Emit `suppression` events and agent log entries that explain each step.

Web:
- "Dispatch drones" on the incident card. Drones fly from docks to the head, return, recharge, and go again.
- Treated cells overlay, a containment progress ring, and the spread animation updating as the prediction shrinks.
- A persistent banner while active: "Simulated suppression. In a real deployment, suppression is done by partner crews or partner drones."

Done when: dispatching drones visibly shrinks the predicted spread, containment rises, and the log explains why.
```

---

## Prompt 8: Agent console, chat, and voice

```
Finish the Agent panel so the operator can see and talk to the agent.

Log tab:
- Group events by agent run. Each run shows the trigger, the mode badge (ASI:One, fallback, or policy backstop), and a list of steps with the tool name and summary. Steps expand to show arguments and results.
- Decision cards at the end of each run with the summary and actions.

Approvals tab:
- Every pending approval with its texts and reason. Approving sends `approve <id>` through the same path as chat, so behavior matches Agentverse.

Chat tab:
- POST /agent/chat calls EmberService.handle_chat for the active zone. Show replies in the thread. Support "status", "approve", and "fire near <place>".

Voice (only if the rest is solid):
- Hold Space to talk. Use the browser SpeechRecognition API where available for speech to text, and send the text to the chat endpoint.
- Read replies aloud with ElevenLabs through a server endpoint that reuses agent/ember/channels.py. Show a clear "Voice unavailable" state on browsers without speech recognition.

Done when: the operator can follow every agent decision step by step, approve from the panel, and chat with the agent by text (and voice, if built).
```

---

## Prompt 9: Demo mode and polish

```
Make the demo reliable and the console look finished.

Demo mode:
- A "Run demo" control that plays the story at 360x: zone and edge servers already deployed, a survey runs, the report opens with the site fly-through, a test fire starts at the top site, a drone verifies it, the agent runs, residents are notified, and suppression contains it.
- Pause, next step, and "Reset demo", which restores a saved snapshot of the zone and clears incidents, alerts, and reports.
- A demo preset zone saved to disk, with cached OpenStreetMap data, so the demo does not depend on venue Wi-Fi.

Hardening:
- Visible badges for any fallback: map, ASI:One, ElevenLabs, OpenStreetMap.
- Reconnect handling, empty states that tell the operator what to do next, and error toasts that say what failed and how to fix it.
- Performance: one texture for the heatmap, sampled trails, no per-cell entities. Check frame rate with the demo running and fix any drops.
- Keyboard shortcuts overlay (press ?).
- prefers-reduced-motion turns off the orbit and sweep animations.

Visual QA:
- Take screenshots of every state: empty, zone drawn, edge servers, survey running, report, incident, approvals, suppression, each filter.
- Fix alignment, contrast over bright 3D tiles, overflowing text, and anything that looks unfinished. Remove one decorative element if the screen feels busy.

Done when: the full demo runs three times in a row with resets in between, with no console errors.
```

---

## Prompt 10 (optional): SpacetimeDB

```
Add SpacetimeDB as the shared event store without removing the WebSocket path.

- On the server, add a store adapter that mirrors every event into SpacetimeDB through its HTTP API, using the table and reducer contract in agent/README.md (detection, agent_event, report_detection, agent_event reducer, mark_detection_handled). Extend the contract with any new event kinds as rows in agent_event.
- Detections written to SpacetimeDB by teammates' drone code must reach the zone's EmberService.
- On the web, add an optional SpacetimeDB subscription data source behind the same store interface, switched by an env flag. The WebSocket source stays the default.
- If SpacetimeDB is unreachable, show a badge and keep running on the WebSocket path.

Done when: with SpacetimeDB configured, a detection inserted by another client triggers the agent, and the dashboard updates from the subscription.
```

---

## When something breaks

```
Something is wrong: [describe what you see, paste the error or a screenshot].
Find the cause before changing code. Tell me what you think is happening and how you will check it, then fix it, add a test that would have caught it, and rerun the tests.
```
