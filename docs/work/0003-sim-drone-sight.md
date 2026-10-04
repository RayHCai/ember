# 0003: Sim without chrome: one drone, what it sees

**Status:** in-progress
**Touches:** apps/sim, services/demo-data

## Goal

The sim has no panels. It is launched from the terminal for exactly one drone (chosen there; a
different drone means restarting it) and the window shows only that drone's model in 3D. Around it,
the whole map is rebuilt in 3D from Demo Data (land cover, roads, trees, buildings, fire), with no
aerial imagery; what the drone's camera can see is drawn at full brightness and everything it
cannot see is darkened. Dragging orbits the
camera around the drone, as in Unity's scene view.

## Plan

- [x] `services/demo-data`: serve OSM roads with the world (`/v1/world/roads.json`), so the ground
      can be rebuilt without imagery
- [x] `apps/sim/scripts/start.mjs`: terminal launcher. Lists the fleet (Drone Info, or the dummy
      tracks), asks which drone, then opens the window (or the browser with `--browser`)
- [x] Tauri shell passes the launch settings (`EMBER_DRONE`, `EMBER_DRONE_INFO_URL`,
      `EMBER_DEMO_DATA_URL`) to the page; the browser reads the same from the query string
- [x] Remove the DOM UI (panels, HUD, sensor feed, screen boxes, view modes) and the imagery ground
- [x] Ground rebuilt from the 10 m fuel grid and the roads; fire compositing kept
- [x] Visibility: a depth pass from the drone camera each frame; every world material darkens what
      is outside that camera's frustum or hidden behind something
- [x] Orbit camera that follows the drone; `F` refocuses on it
- [ ] Run the Tauri window on the demo laptop (only the browser build was checked)

## Decisions

- The drone is chosen in the terminal, not in the window, because the window has no UI at all. The
  launcher passes it in through environment variables that the Tauri shell injects into the page
  (`window.emberSimLaunch`); a browser tab takes the same settings from `?drone=&droneInfo=&demoData=`.
  Rejected: a startup picker in the window (that is GUI), prompting from the Rust shell (stdin is not
  reliably attached under `tauri dev`).
- "Cannot see" means outside the frustum or occluded, tested per fragment against a depth map
  rendered from the drone camera (shadow-map style). Rejected: a screen-space post pass, which
  cannot handle the transparent flames and smoke.
- Smoke and flames do not occlude in the depth pass, and the drone model is never darkened (it sits
  on a layer the drone camera does not render).
- Ground colour comes from the fire model's fuel classes (grass, shrub, tree, urban, structure,
  bare, water), blended across the 10 m cells with noise so edges are not blocky. Tree and roof
  colours sampled from imagery stay: they are per-object attributes of the rebuild, not a texture.
- Any new model or material must keep to the layers (the drone on `LAYER.DRONE` via
  `onDroneLayer` in `view/marker.ts`; flames and smoke on `LAYER.EFFECTS`) and go through
  `withVisibility` (`world/visibility.ts`) or test `emberVisible` itself, or it will show where the
  drone cannot see.
- Unseen is darkened, not hidden or whitened, so the whole map stays readable around the drone's
  view. Every tree chunk is drawn at any range (its `_lod2` beyond 700 m); buildings already were.
- Demo Data's imagery endpoints stay (nothing in the sim uses them now); removing them from the
  world build is a separate cleanup.

## Log

- 2026-10-03: Implemented the plan above.
    - Checks: full gate green; sim 28 tests (vitest); Demo Data 44 tests, including roads in
      `test_world_api`; clippy and rustfmt on the shell.
    - In headless Chrome with Demo Data and the dummy feed: dummy-1 and dummy-3 show the drone,
      frustum and a 3D rebuild of their view with fire and red outlines, white elsewhere and behind
      occluders; an unknown drone shows an all-white world and the "not in the fleet" line.
    - Not checked: orbit and pan by mouse (headless), and the Tauri window itself.
    - Switched unseen from white to darkened, with the whole map drawn (trees no longer stop at
      4.5 km). Typecheck, sim tests and prettier green; not yet checked in a browser.
    - Next: run the Tauri window on the demo laptop and try the camera by hand.
