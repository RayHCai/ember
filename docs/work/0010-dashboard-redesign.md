# 0010: Dashboard redesign

**Status:** done
**Touches:** apps/dashboard

## Goal

The operator dashboard implements every operator view in the readme (sign in, watch zone list,
onboarding, the zone page with its overlays, planners, blasts, operator agent) on
dummy data, in a light, minimal, fire-themed design with the drone-sim mark as its icon language,
and a top-down map.

## Plan

- [x] Light theme tokens, Geist type, faceted icon set built like the Ember mark
- [x] Dummy backend in `src/sim/`: seeded zones, greedy edge server placement, scan engine,
      planners, operator agent, operator actions
- [x] Pages: sign in (7-day device session), zone list, onboarding wizard, zone page
- [x] Map: one persistent Cesium viewer, top-down camera, boundary tool, overlay layers
- [x] Civilian blasts behind a hold-to-approve record
- [x] Playwright specs rewritten for the new UI (16 passing with `PW_CHANNEL=chrome`)
- [x] Removed the previous console's modules and its resident page

## Decisions

- Kept CesiumJS and the map source chain from the previous console; changed only the camera
  (top-down, tilt off) and overlay styling. The viewer is created once and hidden off map pages so
  moving between list and zone never reloads tiles.
- Detection's black and white base is the imagery layer's saturation (a shader on Google tiles), not
  a post-process stage: a post-process would also grey out overlays outside the zone.
- Animated Cesium properties read one per-frame clock (`map/frameClock.ts`). Reading
  `performance.now()` per callback let an ellipse's minor axis exceed its major axis and stopped
  rendering.
- `motion` for page and layout transitions; CSS for hover states.

## Log

- 2026-10-03: Redesign built and checked in Chrome (screenshots of every view, 16 e2e specs). Next:
  remove the old modules, then the full gate.
- 2026-10-03: Old modules removed with the owner's go-ahead; full repo gate passes. Wiring the
  dashboard to services/api is future work: `src/sim/` then becomes the offline fallback.
