# @ember/dashboard

The operator viewpoint: a Tauri desktop app where an operator sets up watch zones, watches the drone
fleet map them, runs the civilian and responder planners, and sends event blasts. The product spec is
the readme's "Operator Dashboard" section; this file is how the package is built.

It runs on the Ember services. Every record and action goes through the **api** over HTTP
(`packages/contracts/src/api.ts`); live drone positions and detections come from **drone-info**'s
WebSocket stream (`droneInfo.ts`), which the dashboard holds open while an operator is signed in.
The only other traffic is map imagery and address search.

## Views

| Route                     | View                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| (signed out)              | Sign in, or create an account: name, email, password. Sessions last 7 days |
| `#/zones`                 | Watch zone cards with totals, status tabs, search and "New watch zone"     |
| `#/zones/new`             | Onboarding step 1: draw the boundary                                       |
| `#/zones/:id/setup/:step` | Onboarding: `boundary` (also "Edit boundary"), `servers`, `drones`         |
| `#/zones/:id`             | The zone: map, operator sidebar, inspector, agent, blasts                  |

Onboarding follows the readme. A zone is complete once its boundary is drawn; edge servers and drones
can come later, and the zone page asks for them.

1. **Boundary**: find a place, click the outline, then "Auto-fit to forest" snaps it to the vegetated
   land under it (the api's forest fit on OpenStreetMap). Saving a new boundary sends the operator
   back to the edge servers.
2. **Edge servers**: the api suggests sites (placements) that lift coverage past 90% for the chosen
   connectivity radius; the operator can pinpoint more by clicking the map and drag them. A site
   becomes an edge server when the operator assigns it a connector that has registered with
   edge-manager. Planned sites flash; deployed ones hold still, grey while offline.
3. **Drones**: a drone pairs by joining an edge server's network; this step lists them as
   edge-manager reports them and shows them live on the map.

The zone page's map has two overlays and a toggle:

- **Operator**: edge servers, pink connectivity radii, drones moving live (or beside their edge
  server until drone-info hears from them), land outside the boundary washed out. Coverage under 90%
  offers suggested placements.
- **Detection**: the base map turns black and white; ground any run has mapped fills in green (the
  running scan's cells brighter), the api's risk zones fill yellow (at risk) and red (on fire), each
  inside a labelled bounding box. While a scan runs, the boxes of the frames drone-info streams in are
  drawn as they land.
- **Suggestions** (on top of Detection, once a planner job has succeeded): fire arrival gradient and
  forecast perimeters, the civilian impact gradient around each civilian area, evacuation routes
  (green clear, amber tight), safe zones, and attack zones with their drop sites and radii.

Scans start and stop through the api, which sends the tasks to edge-manager; repeat scans run on the
api's schedule. Civilian alerts never leave without an approval record: the blast dialog ends in a
hold-to-approve step and the api records the signed-in operator as the approver; blasts drafted
elsewhere wait in the operator panel for that approval. Responder-only blasts are queued directly.

The agent panel maps plain-language commands onto the same api actions the buttons take
(`zone/agent.ts`) and only ever drafts civilian texts.

## Layout

```
src/
  App.tsx, main.tsx   auth gate, hash routes, page transitions; the map stays mounted across pages
  api/                api client and typed routes
  live/               drone-info stream and live telemetry (outside React)
  model/              view of a zone built from the api's records, geometry, rasterising
  auth/               sign-in and sign-up page
  zones/              watch zone list and cards
  setup/              onboarding wizard (boundary, edge servers, drones)
  zone/               zone page: operator panel, inspector, agent and blast dialogs
  chrome/             notifications menu, account menu
  map/                Cesium viewer, camera, input, overlays (layers/) and the boundary tool (tools/)
  store/              zustand stores: zones (records), sync (polling), actions, ui, router, session,
                      notifications
  ui/                 buttons, segmented control, toggle, modal, toasts, panel styles, motion presets
  icons/              the Ember mark and the faceted icon set
  styles/theme.css    design tokens: colors, type, shadows, easing
src-tauri/            Tauri 2 shell (Rust): window, app log, bundling
tests/                Playwright browser tests against the running stack
```

`store/sync.ts` polls the resources the open page shows (every 2 s, faster for a running scan or
planner job) and turns changes into notifications: scans finishing, new fires, plans ready, edge
servers going on or offline, drones pairing. Drone positions change many times a second, so they
live in `live/telemetry.ts` outside React; map layers read them through Cesium callback properties
and draw a drone moving along its last reported velocity between reports.

## Run

```bash
docker compose up -d --build                # the services (needs ./data, see the root AGENTS.md)
pnpm --filter @ember/dashboard app          # desktop app (dev server on :5173)
pnpm --filter @ember/dashboard dev          # same UI in a browser
pnpm --filter @ember/dashboard app:build    # installers under src-tauri/target/release/bundle
pnpm --filter @ember/dashboard test:e2e     # Playwright against the stack; PW_CHANNEL=chrome for installed Chrome
```

The compose stack flies three simulated drones over Lahaina (Demo Data's coverage), so draw the
demo zone there and place its edge server near 20.884, -156.667.

| Variable                    | Default                 | Meaning                              |
| --------------------------- | ----------------------- | ------------------------------------ |
| `VITE_EMBER_API_URL`        | `http://localhost:4001` | api                                  |
| `VITE_EMBER_DRONE_INFO_URL` | `ws://localhost:4002`   | drone-info                           |
| `VITE_CESIUM_ION_TOKEN`     | unset                   | Cesium World Terrain and ion imagery |
| `VITE_GOOGLE_MAPS_API_KEY`  | unset                   | Google Photorealistic 3D Tiles       |

## Map

CesiumJS, always looked at from straight above (tilt and free look are off). Sources, best first:
Google Photorealistic 3D Tiles, Cesium World Terrain with ion imagery, OpenStreetMap imagery.
Keys go in `apps/dashboard/.env` (listed in `.env.example`). Attribution is always shown along the
bottom edge.

## Design

Paper and ink, light mode only: an editorial page (serif headlines, hairline rules) with quiet,
Notion-like controls. Black carries the interface; fire red means fire and alerts, nothing else. It
shares its brand with the other Ember apps: the mark, the Gloock wordmark, Atkinson Hyperlegible.

| Token                         | Value                 | Use                                          |
| ----------------------------- | --------------------- | -------------------------------------------- |
| `--paper` / `--wash`          | `#FFFFFF` / `#F7F6F3` | pages and panels / quiet fills               |
| `--ink`, `--ink-2`, `--ink-3` | `#111110` and greys   | text, primary buttons, selected states       |
| `--line` / `--line-strong`    | `#E9E7E2` / `#D3D0C9` | hairline rules / control borders             |
| `--fire`                      | `#E5321F`             | active fire, live scans, errors, unread dots |
| `--risk`                      | `#F2A900`             | at-risk only                                 |
| `--boundary`                  | `#2F6BFF`             | watch zone boundaries                        |
| `--radius-pink`               | `#FF4FA3`             | edge server connectivity radii               |
| `--route`                     | `#12A37A`             | evacuation routes and safe zones             |

- Type: Gloock for the wordmark, titles and large numbers; Atkinson Hyperlegible (400 and 700) for
  everything else; the system monospace for coordinates and IDs. Sentence case.
- Icons: every glyph is built like the Ember mark (`assets/brand/icon.svg`): flat facets with seams
  (`src/icons/glyphs.ts`). Map badges are drawn from the same glyphs. The app icon is the mark.
  A seam takes `--facet`, so any rule that changes a background also sets `--facet` to match.
- Layout: a 56px top bar and a docked left sidebar on map pages; the inspector, agent, legend and
  scan readout float over the map as white cards. No gradients, no glass.
- Motion: one language, in `src/ui/motion.ts` (`QUICK`, `SMOOTH`, `SNAP`) and the `--ease`, `--fast`
  and `--base` tokens. Pages fade and rise, panels slide from their edge, markers slide under the
  active tab or segment, every control eases on hover and presses in on click. Everything honours
  `prefers-reduced-motion`.
- Copy: labels and plain verbs ("Run scan now", "Assign servers", "Hold to approve and send").
  No explanatory paragraphs, no em dashes.
