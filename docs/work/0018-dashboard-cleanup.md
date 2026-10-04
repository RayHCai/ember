# 0018: Dashboard cleanup

**Status:** done
**Touches:** apps/dashboard

## Goal

Setting up a watch zone is drawing its outline and pressing Next. The dashboard asks for no name,
address, radius or server assignment, and shows no sidebar: only the map, a top bar on the zone page,
and an inspector for whatever is clicked.

## Plan

- [x] Draw page (`src/setup/DrawPage.tsx`) replaces the three-step wizard: bare map, a place search,
      Next at the bottom right once the outline is closed
- [x] Drag to trace an outline (`src/map/tools/BoundaryTool.tsx`, strokes in `src/map/input.ts`,
      `simplify` in `src/model/geo.ts`); clicking point by point still works
- [x] Next stores the zone and asks the api for suggested placements, then opens the zone
- [x] Zone page without the operator sidebar: Scan, repeat interval and "Review blast" moved to the
      top bar; Suggestions runs the planners itself
- [x] Edge servers connect without an operator step (`useAutoAssign` in `src/zone/ZonePage.tsx`)
- [x] Inspector and zone cards trimmed: no coordinates, addresses, ids, radii or counts
- [x] `tests/flow.spec.ts` follows the new flow (not run: see Log)

## Decisions

- Zones are named by the dashboard (`Zone N`), because the api requires a name and notifications
  and the zone list need something to call a zone. Region is no longer sent.
- The api has no rule for which connector serves which site, so the dashboard assigns: while a zone
  with planned sites is open, an unassigned edge server that edge-manager reports online takes the
  next planned site. This claims any free connector for whichever zone is open; moving that rule
  into the api (a connector registering for a zone) is the proper fix and is not done here.
- A place search stays on the draw page. Without it the only way to reach a forest is to pan across
  the globe.
- While an outline is open a drag draws, so the map moves with Space held, the wheel, or the search.
- Removed with the sidebar and wizard, with no replacement: auto-fit to forest, pinpointing a site
  by hand, choosing the connectivity radius (the api default of 500 m is used), clearing sites,
  coverage and fleet counts, the list of past blasts, the zone list's totals and search.
- Boundary editing stays, as a pencil in the top bar, because a zone cannot otherwise be corrected.
- The Event blast button is gone, and so are the zone page's status tag, notifications menu,
  repeat-scan control and Operator Agent panel (its code, `zone/agent.ts`, and the coverage-gaps
  overlay only it opened were deleted). Blasts start from the inspector. A civilian blast drafted
  by the operator-agent service still shows "Review blast" in the top bar, because without it that
  draft could never be approved. Repeat scans keep running on whatever interval a zone already
  has; the dashboard no longer sets one. The zone list keeps its notifications menu.
- One arrival gradient: the planner's fire arrival time per cell already says when each civilian
  area is reached, so the separate magenta civilian gradient was dropped and areas are outlined in
  the gradient color of their own arrival time.
- Map overlays (`GridOverlay`) sit first in `scene.groundPrimitives`, so routes, rings and outlines
  always draw over the paint. Evacuation routes were invisible because Cesium does not draw
  `PolylineArrowMaterialProperty` on ground-clamped lines; they are now solid, 12 px over a 20 px
  white edge, ordered by `zIndex`. The fire track had the same problem.
- Trackpad pinch (Ctrl+wheel) is handled by the dashboard (`pinchZoom` in `src/map/camera.ts`),
  zooming about the pointer, and never zooms the page; Cesium's own wheel zoom stays for scrolling.

## Log

- 2026-10-04: Implemented. Typecheck, lint, format and build pass. The e2e flow was rewritten but
  not run: it needs the compose stack and sends an approved blast through it.
- 2026-10-04: Second pass from an annotated screenshot: Event blast removed, one arrival gradient,
  thicker routes, seamless map badges at device resolution, pinch zoom and +/- buttons. Checked in
  headless Chrome against a mocked api with a synthetic plan, at 1x and 2x pixel density.
- 2026-10-04: Third pass: status tag, notifications, repeat-scan and agent buttons removed from the
  zone page; the e2e blast step now drafts from a civilian area's inspector.
