# @ember/drone-sim

Ember Drone Sim: a desktop app (Tauri + Three.js) that shows **one drone**, chosen when the sim starts, as
a model in the Lahaina scenario, with the whole scenario map rebuilt in 3D from Demo Data. Whatever
that drone's camera can see is drawn at full brightness; everything it cannot see, outside its field
of view or hidden behind trees and buildings, is darkened. The window has no panels or controls;
drag to move the camera around the drone.

The sim moves no drone and runs no detector. It only renders what two services give it:

- **Drone Info** (`services/drone-info`): the fleet, and for the chosen drone its pose, camera and
  detections, over the stream in `packages/contracts/src/droneInfo.ts`.
- **Demo Data** (`services/demo-data`): the scenario rebuilt in 3D (`/v1/world`).

## Run

```bash
# 1. Demo Data (first /v1/world request builds the world: about 2 minutes, then cached)
cd services/demo-data && uv run demo-data serve

# 2. The sim: opens the window on a connect screen
pnpm --filter @ember/drone-sim start
pnpm --filter @ember/drone-sim start --drone dummy-1     # skip the connect screen
pnpm --filter @ember/drone-sim start --browser           # same view in a browser tab instead
```

| Flag           | Env                    | Default                 | Meaning                                       |
| -------------- | ---------------------- | ----------------------- | --------------------------------------------- |
| `--drone`      |                        | asked in the window     | The one drone this instance shows             |
| `--drone-info` | `EMBER_DRONE_INFO_URL` | empty: dummy drones     | Drone Info service (`host:port` or a URL)     |
| `--demo-data`  | `EMBER_DEMO_DATA_URL`  | `http://localhost:8090` | Demo Data service                             |
| `--browser`    |                        | off                     | Serve for a browser tab, not a desktop window |

### Watching drone-runtime drones fly

```bash
cd services/demo-data && uv run demo-data serve --start 2023-08-08T15:00   # paused: set 30x and play at :8090/control
pnpm --filter @ember/drone-info build && node services/drone-info/dist/main.js     # port 4002
uv run --package ember-drone-runtime drone-runtime swarm-sim --drone-info http://localhost:4002
pnpm --filter @ember/drone-sim start --drone sim-1 --drone-info localhost:4002
```

The swarm takes off over the burning part of town, maps a 300 m radius and lands; `sim-1`,
`sim-2` and `sim-3` can each be shown. Boxes are what the drone's detector found in Demo Data's
frames, so they sit on the fire the sim draws.

The drone is fixed for the life of the process; to show another one, restart the sim. The launcher
(`scripts/start.mjs`) passes the choice to the window through those environment variables, which the
Tauri shell hands to the page as `window.emberSimLaunch`. A browser tab takes the same settings from
the URL: `http://localhost:5180/?drone=dummy-1&droneInfo=...&demoData=...`.

The window's content security policy (`src-tauri/tauri.conf.json`) lets it reach services on this
machine only. When `--drone-info` or `--demo-data` names another host, the launcher adds exactly that
host to the policy for the run. A `tauri build` keeps the loopback-only policy.

Without `--drone`, the window opens on a connect screen with one field: the drone ID to show. Left
empty, it shows the first drone the fleet reports. "Connect over USB" is there but disabled until
drones speak a device protocol.

Text appears at the bottom of the window only while something blocks the view: loading the world,
connecting, waiting for the drone's first telemetry, a drone that is not in the fleet, or a drone
that has gone quiet.

## Camera

| Input                | Does                                         |
| -------------------- | -------------------------------------------- |
| Left drag            | Orbit around the drone                       |
| Right or middle drag | Pan                                          |
| Wheel                | Zoom toward the orbit point                  |
| `F`                  | Back to the drone, keeping the viewing angle |

The orbit point travels with the drone, so the view keeps whatever angle and pan you set as it flies.

## What is drawn

The whole map is drawn, in and out of the drone's view. The scene is rebuilt from Demo Data's `/v1/world`, never textured with its
aerial imagery. Every object in it is a low-poly model from the repo's `assets/` (`world/models.ts`
loads them; Vite bundles the `.glb` files). The sim builds no shapes of its own: it places, scales,
recolours and animates those models. The only geometry made here is the overlay lines listed under
"Always drawn".

- **Ground**: the `assets/` ground square stretched over the world and painted as flat facets by
  the fire model's 10 m fuel classes (grass, shrub, tree, urban, structure, bare, water), with the
  OpenStreetMap roads at their paved width. Behind the fire front it chars; flames and embers are
  composited on it.
- **Trees**: ~115k individual trees, each one of the two models of its growth form, scaled to its
  surveyed height and crown radius. Foliage is the model's green shifted towards the hue of the
  crown in the imagery. Chunks within 170 m of the camera use the full model, to 700 m the `_lod1`
  one, beyond that `_lod2`, out to the edge of the map. Trees burn, scorch, or lose their foliage to a charred skeleton as the
  fire passes.
- **Buildings**: the 2,969 pre-fire footprints, each covered by models from the building kit
  (`layout` in `world/footprints.ts`). A gable footprint takes the house nearest its size and
  height; a flat roof takes a town block, an irregular outline one block per wing. Footprints
  longer or larger than any model become a row of them. Fronts face the nearest road. Roofs take
  the palette colour nearest the roof in the imagery; walls a colour of their own. Within 320 m of
  the camera a building is drawn in full, beyond that as its `_lod1`. Destroyed buildings burn,
  then collapse into a ruin model.
- **Fire**: per-cell timing evaluated every frame: flame models (tall on trees and buildings, a low
  spread on grass) that flicker, smoke puffs that rise, grow and fade downwind, and firelight.
- **Light**: sun position and colour for the scenario time; the town burns into the night after
  sunset (19:05 HST). The sky is blue by day, navy at night, and greyed by smoke while the town
  burns.

Always drawn: the drone (drawn six times life size so it reads from the orbit distance, rotor
blurs on, camera gimbal at the reported pitch), its camera's frustum and ground footprint (blue lines), and the
ground zone of each risk it reported (a translucent fill with a solid edge), magenta for `on_fire` and
cyan for `at_risk` (not the spec's red and yellow, which vanish against the flames), for 6 s after
its frame.

"Can see" is tested per pixel, like a shadow map. Every frame the scene's depth is rendered from the
drone's camera (`world/visibility.ts`), and each world material darkens any point outside that
camera's frustum or farther than what the depth map holds there. Smoke and flames do not block the
view, and the drone model is never darkened.

## Drone data

With `--drone-info` set, the sim reads `ws://<drone-info>/v1/stream`: a `fleet` snapshot about once a
second, then `telemetry` (10 Hz) and `detections` (one per captured frame) for the chosen drone.
The followed drone is drawn 300 ms behind its own clock, placed by each message's `sentAt` rather
than when it arrived, so uneven delivery does not show as the drone lurching
(`src/droneInfo/track.ts`).

Without `--drone-info`, the sim plays **dummy drone data**
(`src/droneInfo/dummy.ts`) behind the same interface:

- one drone, `dummy-1`, hovers at a fixed pose south of Front St looking north (`dummyDrone.ts`);
- its scenario time is Demo Data's clock (`PUT /v1/clock` to move or speed it up), and its
  detections are the thermal hotspots (600 K and hotter) Demo Data reports for a camera at the
  drone's pose, as `on_fire` zones. There are no `at_risk` zones in the dummy data.

## Layout

```
scripts/start.mjs   launcher: passes the launch settings and opens the window or a browser tab
src/
  app.ts            render loop, orbit camera, status line
  launch.ts         launch settings from the Tauri shell or the URL
  droneInfo/        Drone Info client, dummy stand-in, message validation, the drone's track
  world/            world assets and models, ground shader, vegetation, buildings (footprints.ts
                    picks their models), fire, light, visibility
  view/             drone camera (pose -> Three.js camera), drone model and outlines
src-tauri/          Tauri 2 shell: the window, and the launch settings handed to it
```

Checks: `pnpm --filter @ember/drone-sim typecheck | test | build`. `lint` and `format:check` run clippy
and rustfmt on the shell.
