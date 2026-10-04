# 0015: Dashboard on the api

**Status:** done
**Touches:** apps/dashboard, services/api, services/edge-manager, internal/, services/drone-info,
packages/contracts, compose.yaml, docs/architecture.md

## Goal

The operator dashboard runs on the real services instead of `src/sim/`: operators sign up and sign
in against the api, create and fit watch zones, plan and assign edge servers, watch drones fly live
over drone-info's WebSocket, and see mapped ground, merged risk zones (with bounding boxes) and the
planner's spread forecast, civilian impact, evacuation routes and attack zones on the map.

## Plan

- [x] Contracts: operator auth, zone schedule and region, zone summaries, placements, scans, risk
      zones, surroundings, weather, forest fit, blasts (`api.ts`); `watch` viewer message
      (`droneInfo.ts`)
- [x] api: operators and sessions (scrypt, 7 days), CORS, zone fields and summaries, edge server
      `PATCH` and live status from edge-manager, placements (suggest, pinpoint, move, assign),
      scans (start and stop through edge-manager, repeat schedule, state from mapping runs), risk
      zones merged from detections, blasts with approval records, planner context filled from
      stored surroundings, risk zones and weather
- [x] api open data (`services/api/src/openData/`): forest fit, surroundings and weather from
      OpenStreetMap (Overpass) and Open-Meteo
- [x] edge-manager posts to the api: edge server on register, drones, mapping-run updates and
      detections from each update; Go mirror of the shapes in `internal/`
- [x] drone-info: `watch` a list of drones
- [x] dashboard: api client and drone-info stream replace `src/sim/`; sign-up; every view on real
      records; live drones; risk zone boxes; suggestions from `PlannerResult`
- [x] compose: api reaches edge-manager, edge-manager reaches the api, drones fly through the
      edge-connector instead of the `swarm-sim` stand-in
- [x] Docs: architecture channels, READMEs; end-to-end run on the compose stack

## Decisions

- The dashboard talks to the api over HTTP and to drone-info over one WebSocket, nothing else (map
  imagery and geocoding aside). Live positions come from drone-info; everything else is the api's
  record, polled.
- Operators sign in with a session token the api issues (stored hashed); the same `/v1` routes
  take it alongside the service keys. Sign-up is back in the UI because the readme asks for it.
- Planned edge server sites are api records (placements), not dashboard state, so a crew can
  install hours later and the operator-agent can use them. A placement becomes an edge server when
  the operator assigns a registered connector to it.
- Coverage and placement suggestions are computed in the api on a grid over the boundary (greedy
  set cover); the dashboard recomputes coverage locally only to draw gaps and to give instant
  feedback while a site is dragged.
- Detection ids are per frame, so the api merges a zone's detections since the latest scan into
  risk zones (connected cells of one class) with a bounding box each. The planner context gets the
  same risk zones.
- Civilian areas, roads, safe zones and stations come from OpenStreetMap when a zone is created or
  its boundary changes, stored per zone; weather from Open-Meteo at planning time. Both degrade to
  empty, which the planner already lists as assumptions. Forest fit uses the same Overpass data.
- Blasts are records with an approval: civilian audiences wait in `pending_approval` until an
  operator approves. Nothing delivers them yet; the civilian agent will read `queued` blasts.
- Civilian reports, check-ins and responders are not shown: no service writes them yet.
- Drones pair physically (a drone joins an edge server's network); the dashboard's drone step only
  watches them arrive through edge-manager's records. The old "start pairing" button is gone.
- One planner job answers both planners (the planner computes spread, attack zones, impacts and
  routes together), so the panel has one "Run planners" button and two result rows.
- The agent panel keeps its plain-language commands (`zone/agent.ts`) on the real actions until
  the operator-agent service answers it.
- Playwright tests run against the compose stack, not a mock: they sign up a fresh operator, so
  they need no seeded data, and the flow test flies the compose drones over Lahaina.

## Log

- 2026-10-04: Contracts written; api, open data and edge-manager work running in parallel with the
  dashboard and drone-info.
- 2026-10-04: Done. On the compose stack the Playwright flow passes end to end: sign-up, a zone
  drawn over Lahaina, a pinpointed site assigned to the compose edge-connector, the three drones
  pairing, a scan flying live (8.7% of the disc and 5 on-fire risk zones from 34 detection frames
  in about a minute), the planner (OSM surroundings: 11 civilian areas, 423 roads, 8 safe zones, 2
  stations), and a civilian blast queued with its approver. Gate: lint, typecheck, build and tests
  pass; `format:check` fails only on `docs/raspberry-pi.md` and demo-data's `control.html`, which
  this work did not touch. Left for later: in headless Chrome (software WebGL) the civilian impact
  gradient shows a one-pixel horizontal seam across its ground primitive, to check on a real GPU;
  the operator-agent service should replace the panel's local commands; nothing delivers `queued`
  blasts yet; the planner context has no terrain; deploying the migrations to the shared database
  (0014).
