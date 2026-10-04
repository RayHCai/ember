# @ember/dashboard

The operator viewpoint: a Tauri desktop app where an operator sets up watch zones, watches the drone
fleet map them, runs the civilian and responder planners, and sends event blasts. The product spec is
the readme's "Operator Dashboard" section; this file is how the package is built.

**It runs on built-in dummy data.** It talks to no Ember service yet: `src/sim/` stands in for the
api, edge manager, drone info, planner and operator agent, and answers every action the UI takes. The
only network traffic is map imagery and address search.

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
  store/              zustand stores: zones, ui, router, session, notifications
  ui/                 buttons, segmented control, toggle, modal, toasts, panel styles
  icons/              the Ember mark and the faceted icon set
src-tauri/            Tauri 2 shell (Rust): window, app log, bundling
tests/                Playwright browser tests, all on the dummy data
```

Drone telemetry changes every frame, so it lives in `sim/live.ts` outside React; map layers read it
through Cesium callback properties and panels poll it.

## Run

```bash
pnpm --filter @ember/dashboard app         # desktop app (dev server on :5173)
pnpm --filter @ember/dashboard dev         # same UI in a browser
pnpm --filter @ember/dashboard app:build   # installers under src-tauri/target/release/bundle
pnpm --filter @ember/dashboard test:e2e    # Playwright; add PW_CHANNEL=chrome to use installed Chrome
```

Demo account: `operator@ember.dev` / `wildfire` (the sign-in page can fill it in).

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
