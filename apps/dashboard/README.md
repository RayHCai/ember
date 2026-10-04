# @ember/dashboard

The operator viewpoint: a Tauri desktop app where an operator sets up watch zones, watches the drone
fleet map them, runs the civilian and responder planners, and sends event blasts. The product spec is
the readme's "Operator Dashboard" section; this file is how the package is built.

It runs on the Ember services. Every record and action goes through the **api** over HTTP
(`packages/contracts/src/api.ts`); live drone positions and detections come from **drone-info**'s
WebSocket stream (`droneInfo.ts`), which the dashboard holds open while an operator is signed in.
The only other traffic is map imagery and address search.

## Views

| Route              | View                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| (signed out)       | Sign in, or create an account: name, email, password. Sessions last 7 days |
| `#/zones`          | Watch zone cards with status tabs and "New watch zone"                     |
| `#/zones/new`      | Draw a zone on the bare map                                                |
| `#/zones/:id/edit` | Redraw that zone's boundary                                                |
| `#/zones/:id`      | The zone: map, top bar, and an inspector for whatever is clicked           |

Setting up a zone takes one decision, its outline. Nothing is typed: the dashboard names zones
`Zone 1`, `Zone 2` and so on.

1. **Draw**: drag on the map to trace the outline (it closes on release), or click point by point
   and click the first point. Space held lets a drag move the map; Backspace steps back and Escape
   starts over. A closed outline can be adjusted by its points.
2. **Next** appears once the outline is closed. It stores the zone and has the api suggest edge
   server sites (placements) that cover it, then opens the zone. Planned sites flash and can be
   dragged.
3. **Edge servers connect on their own**: while a zone with planned sites is open, an edge server
   that edge-manager reports online and that no zone has yet is assigned to the next planned site.
   It then holds still, grey while offline. Drones appear as they pair with it, and Scan turns on
   once an edge server is connected.

The zone page's map has two overlays and a toggle:

- **Operator**: edge servers, pink connectivity radii, drones moving live (or beside their edge
  server until drone-info hears from them), land outside the boundary washed out.
- **Detection**: the base map turns black and white; ground any run has mapped fills in green (the
  running scan's cells brighter), the api's risk zones fill yellow (at risk) and red (on fire), each
  inside a labelled bounding box. While a scan runs, the boxes of the frames drone-info streams in are
  drawn as they land.
- **Suggestions** (on top of Detection; turning it on runs the planners when there is no plan or
  the plan is older than the last scan, and it turns itself on when a new plan lands while the zone
  is open): one red-orange-yellow gradient for when the fire arrives
  (red now, pale yellow at the horizon), each civilian area outlined in the color of its arrival
  time, forecast perimeters, evacuation routes as thick lines (green clear, amber tight), safe
  zones, and attack zones with their drop sites and radii.

There is no sidebar: the top bar holds the zone name, a redraw pencil, the overlay switch and Scan,
and clicking an edge server, drone, risk zone or planned place opens its inspector. Blasts start from
the inspector (a fire, a civilian area, an attack zone). The map zooms with the wheel, a trackpad
pinch (which never zooms the page) or the +/- buttons at the bottom right. Scans start and stop
through the api, which sends the tasks to edge-manager; repeat scans run on the api's schedule, which
the dashboard no longer sets. Civilian alerts never leave without an approval record: the blast
dialog ends in a hold-to-approve step and the api records the signed-in operator as the approver;
blasts drafted elsewhere (the operator-agent service) show a "Review blast" button in the top bar
until approved. Responder-only blasts are queued directly.

## Layout

```
src/
  App.tsx, main.tsx   auth gate, hash routes, page transitions; the map stays mounted across pages
  api/                api client and typed routes
  live/               drone-info stream and live telemetry (outside React)
  model/              view of a zone built from the api's records, geometry, rasterising
  auth/               sign-in and sign-up page
  zones/              watch zone list and cards
  setup/              the draw page for a new zone or a redrawn boundary
  zone/               zone page: top bar, inspector and blast dialog
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

The compose stack flies two simulated drones over Lahaina (Demo Data's coverage), so draw the
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
bottom edge. The map draws at the screen's pixel density, not Cesium's default of CSS pixels, so
lines and badges stay crisp on high-density displays. Lines draped over the map take solid colors
only: Cesium does not draw arrow materials on them.

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
  (`src/icons/glyphs.ts`). Map badges are drawn from the same glyphs without seams (`smooth`), so at
  map size they read as one rounded silhouette. The app icon is the mark.
  A seam takes `--facet`, so any rule that changes a background also sets `--facet` to match.
- Layout: a 56px top bar on the zone page and nothing docked beside the map; the inspector,
  legend and scan readout float over the map as white cards. No gradients, no glass.
- Motion: one language, in `src/ui/motion.ts` (`QUICK`, `SMOOTH`, `SNAP`) and the `--ease`, `--fast`
  and `--base` tokens. Pages fade and rise, panels slide from their edge, markers slide under the
  active tab or segment, every control eases on hover and presses in on click. Everything honours
  `prefers-reduced-motion`.
- Copy: labels and plain verbs ("Scan", "Next", "Hold to approve and send").
  No explanatory paragraphs, no em dashes.
