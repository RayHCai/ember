# @ember/dashboard

The operator viewpoint: a Tauri desktop app where an operator sets up watch zones, watches the drone
fleet map them, runs the civilian and responder planners, and sends event blasts. The product spec is
the readme's "Operator Dashboard" section; this file is how the package is built.

**Every zone but one runs on built-in dummy data.** `src/sim/` stands in for the api, edge manager,
drone info, planner and operator agent, and answers every action the UI takes on those zones. One
live watch zone comes from the Ember api through the dev server (see Live mode); beyond that the only
network traffic is map imagery and address search.

## Views

| Route                       | View                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| (signed out)                | Sign in / create account. Email and password, kept on this device for 7 days |
| `#/zones`                   | Watch zone cards with search, status filters and "New watch zone"            |
| `#/zones/new`               | Onboarding step 1: draw the boundary                                         |
| `#/zones/:id/setup/:step`   | Onboarding: `boundary` (also "Edit boundary"), `servers`, `drones`           |
| `#/zones/:id`               | The zone: map, operator panel, inspector, agent, blasts, responder QR        |

Onboarding follows the readme: a zone is complete once its boundary is drawn; edge servers and drones
can come later, and the zone page asks for them. Editing a boundary rebuilds the grid and sends the
operator back to recompute edge server placements.

The zone page's map has two overlays and a toggle:

- **Operator**: edge servers (pending ones flash), pink connectivity radii, drones at their last
  position, land outside the boundary washed out. Coverage under 90% offers suggested placements.
- **Detection**: the base map turns black and white; mapped ground fills in green, at-risk cells
  yellow, burning cells red. A running scan sweeps across it live.
- **Suggestions** (on top of Detection, once a planner has run): fire arrival gradient and
  hurricane-style forecast cone, civilian impact gradient, evacuation routes to safe zones, and
  responder drop sites.

Civilian alerts never leave without an approval record: the blast dialog and the agent's drafts
both end in a hold-to-approve step. Responder-only blasts send directly.

## Layout

```
src/
  App.tsx, main.tsx   auth gate, hash routes, page transitions; the map stays mounted across pages
  auth/               sign-in page
  zones/              watch zone list and cards
  setup/              onboarding wizard (boundary, edge servers, drones)
  zone/               zone page: operator panel, inspector, agent, blast and responder dialogs
  chrome/             notifications menu, account menu
  map/                Cesium viewer, camera, input, overlays (layers/) and the boundary tool (tools/)
  sim/                dummy backend: seeded zones, scan engine, planners, agent, operator actions
  live/               the live zone: api client, poller, api-to-dashboard mapping, live panels
  store/              zustand stores: zones, ui, router, session, notifications
  ui/                 buttons, segmented control, toggle, modal, toasts, panel styles
  icons/              the Ember mark and the faceted icon set
src-tauri/            Tauri 2 shell (Rust): window, app log, bundling
tests/                Playwright browser tests, all on the dummy data (live mode off)
```

Unit tests (`src/**/*.test.ts`, vitest) cover the api-to-dashboard mapping.

Drone telemetry changes every frame, so it lives in `sim/live.ts` outside React; map layers read it
through Cesium callback properties and panels poll it.

## Run

```bash
pnpm --filter @ember/dashboard app         # desktop app (dev server on :5173)
pnpm --filter @ember/dashboard dev         # same UI in a browser
pnpm --filter @ember/dashboard app:build   # installers under src-tauri/target/release/bundle
pnpm --filter @ember/dashboard test        # vitest unit tests
pnpm --filter @ember/dashboard test:e2e    # Playwright; add PW_CHANNEL=chrome to use installed Chrome
```

Demo account: `operator@ember.dev` / `wildfire` (the sign-in page can fill it in).

## Live mode

```bash
EMBER_OPERATOR_KEY=<key> pnpm --filter @ember/dashboard dev   # key from ~/.ember/secrets.env
```

The dev server proxies `/ember-api/*` to the api (`EMBER_API_URL`, default `http://localhost:4001`)
and adds `Authorization: Bearer $EMBER_OPERATOR_KEY` itself, so the key never reaches the bundle.
`EMBER_LIVE=0` turns the proxy off (the Playwright tests do). A build without the proxy (the Tauri
bundle) shows "Live system unavailable" and the simulated zones work as before.

The api's watch zone named `Lahaina` appears in the zone list as "Lahaina · Live". Its page polls the
api every 3 s (the zone list every 15 s) and maps what it reads onto the same layers the simulated
zones use:

- **Operator**: the boundary, edge servers with their connectivity radii, and edge-manager's live
  status in the inspector.
- **Detection**: ground inside an edge server's radius shows as watched; detection outlines and risk
  zones paint at-risk or on-fire cells. Dismissed detections and those of closed incidents are left out.
  Roads draw thin; blocked ones red and dashed, uncertain ones amber.
- **Suggestions**: the plan of the open incident, else the newest routine plan: fire arrival gradient,
  isochrone contours and track cone, civilian impact by area, evacuation routes with their alternate
  (dashed), and attack zones as drop sites with the crews assigned to them.

A status strip shows the open incident, the age of the plan and how many alerts await approval;
toasts announce a new incident, plan or alert. If the api stops answering, a banner says so and
polling keeps retrying; the last data stays on the map.

What the operator can do there:

- **Start a fire here** arms a one-click placement: the click posts a simulated detection (150 m,
  on fire). Ember's operator-agent verifies it, opens an incident, plans and drafts alerts within about
  30 s.
- **Block or reopen a road**: click a road to post an operator road observation; Ember replans.
- **Alerts awaiting approval**: each pending civilian alert shows its area, severity, recipients and
  first text. Hold to approve sends the decision with its confirmation code; operator-agent then texts
  the civilians with a route map. Reject sends nothing.

Simulator actions (scans, path planners, event blasts, responder pairing, the in-app agent) are off
on the live zone; Ember runs those itself.

## Map

CesiumJS, always looked at from straight above (tilt and free look are off). Sources, best first:
Google Photorealistic 3D Tiles, Cesium World Terrain with ion imagery, OpenStreetMap imagery.
Keys go in `apps/dashboard/.env` (listed in `.env.example`): `VITE_CESIUM_ION_TOKEN`,
`VITE_GOOGLE_MAPS_API_KEY`. Attribution is always shown along the bottom edge.

## Design

Light, warm and minimal, with fire as the accent.

| Token                       | Value                 | Use                                          |
| --------------------------- | --------------------- | -------------------------------------------- |
| `--bg` / `--surface`        | `#FBF8F5` / `#FFFFFF` | page, cards and panels                       |
| `--ink`                     | `#1C1714`             | text, selected states, edge server badges    |
| `--flame`, `--gradient-flame` | `#F2541B`, amber to red | primary actions and the brand             |
| `--risk` / `--fire`         | `#F2A900` / `#E5321B` | at-risk and on-fire only                     |
| `--boundary`                | `#2F6BFF`             | watch zone boundaries                        |
| `--radius-pink`             | `#FF4FA3`             | edge server connectivity radii               |
| `--route`                   | `#12A37A`             | evacuation routes and safe zones             |

- Type: Geist for UI, Geist Mono for numbers, coordinates and IDs. Sentence case.
- Icons: every glyph is built like the Ember mark (the drone-sim icon): flat facets with seams
  (`src/icons/glyphs.ts`). Map badges are drawn from the same glyphs. The app icon is the mark.
- Floating panels are frosted glass over the map; the map is never boxed in.
- Motion: page transitions, a camera dive into each zone, springs on panels and hovers, count-ups
  on numbers. Everything honours `prefers-reduced-motion`.
- Copy: plain verbs ("Run scan now", "Deploy 3 servers", "Hold to approve and send"), no em dashes.
