# Ember

A wildfire watch console for forest and city land managers, built at MHacks 2026. It's a macOS desktop app (Tauri) with a 3D globe. Operators draw a watch zone, place drone docks, and follow surveys, risk reports, fires, alerts and suppression.

**Everything in this build runs on built-in dummy data.** There is no backend to start and no Python. Every drone, report, fire, resident and alert is simulated and labeled `SIM`, and every alert starts with "Demo alert."

## Run it

You need Node 20 or later (22 recommended) and Rust.

```sh
make setup     # install dependencies (once)
make app       # open Ember as a desktop app
make bundle    # build Ember.app (web/src-tauri/target/release/bundle/macos/)
make test      # typecheck and browser tests
```

`make dev` runs the same console in a browser, which is useful for debugging.

## Try the demo

The app opens on a demo zone in the Angeles foothills. Its edge servers are deployed and its last report is filed.

- **Run demo** (bottom bar) plays the whole story at 360x: survey, report, a hotspot, drone verification, alerts by tier, suppression, containment. Use **Pause**, **Next step** and **Reset demo** to present it beat by beat.
- **Open report** shows the ranked sites. Picking one flies there, takes a photo from the map, switches to Thermal and orbits.
- **Start test fire** then a click inside a zone starts a simulated fire there. On the incident card, use **Dispatch drones** to suppress it and **Phone preview** to see what a resident anywhere would receive.
- **New zone** lets you draw your own zone. It gets dummy towns, shelters and roads. Then use **Suggest edge servers** (drag, add or right-click to remove), **Deploy edge servers**, then **Run survey**.
- Keys: **1 to 4** switch the map filter (Normal, Thermal, Night, CRT). **?** lists every shortcut.

## Resident page on a phone

`make phones` serves the resident alert page on your Wi-Fi. On a phone, open the "Network" address it prints and add `/alert`. Choose a town, tap **Tap to enable sound**, and alerts arrive as the demo plays.

Alerts only arrive while the page is open. Real background push needs a service worker and HTTPS, which this build does not include.

## Maps

There are no keys by default, so the globe uses OpenStreetMap imagery and says so in a badge. For better maps, put keys in `web/.env` (see `web/.env.example`):

- `VITE_GOOGLE_MAPS_API_KEY`: Google Photorealistic 3D Tiles
- `VITE_CESIUM_ION_TOKEN`: Cesium World Terrain and satellite imagery

## Connecting the real logic service

The drone, survey, report, fire and alert logic lives in a separate service. To use it instead of the dummy data, set `VITE_SERVER_URL` in `web/.env` to its address. The service then has to:

- send events over a WebSocket at `/ws`: a `snapshot` first, then each event as it happens
- answer the operator actions the console sends (approve, hold, test fire, dispatch drones, chat, zone setup)

The event shapes and the action routes are in [CLAUDE.md](CLAUDE.md#events-logic-service-or-the-dummy-backend-to-the-console). The dummy backend in `web/src/data/demo/` sends exactly those events, so it doubles as a working example.

## Layout

```
web/                  React + TypeScript console, CesiumJS globe
web/src/data/demo/    dummy backend: scenario data and the demo player
web/src/resident/     resident alert page (/alert)
web/src-tauri/        Tauri desktop shell (Rust)
web/tests/            Playwright browser tests
```
