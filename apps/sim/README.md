# @ember/drone-sim

Ember Drone Sim: a desktop app (Tauri + Three.js) that shows **one drone**, chosen when the sim starts, as
a model in the Lahaina scenario. Whatever that drone's camera can see is rebuilt in 3D from Demo
Data. Everything it cannot see, outside its field of view or hidden behind trees and buildings, is
white. The window has no panels or controls; drag to move the camera around the drone.

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

The drone is fixed for the life of the process; to show another one, restart the sim. The launcher
(`scripts/start.mjs`) passes the choice to the window through those environment variables, which the
Tauri shell hands to the page as `window.emberSimLaunch`. A browser tab takes the same settings from
the URL: `http://localhost:5180/?drone=dummy-1&droneInfo=...&demoData=...`.

Without `--drone`, the window opens on a connect screen with one field: the drone ID to show. Left
empty, it shows the first drone the fleet reports. "Connect over USB" is there but disabled until
drones speak a device protocol.

Text appears at the bottom of the window only while something blocks the view: loading the world,
connecting, waiting for the drone's first telemetry, a drone that is not in the fleet, or a drone
that has gone quiet.

## Camera

| Input                     | Does                                          |
| ------------------------- | --------------------------------------------- |
| Left drag                 | Orbit around the drone                        |
| Right or middle drag      | Pan                                           |
| Wheel                     | Zoom toward the orbit point                   |
| `F`                       | Back to the drone, keeping the viewing angle  |

The orbit point travels with the drone, so the view keeps whatever angle and pan you set as it flies.

## What is drawn

Inside the drone's view, the scene is rebuilt from Demo Data's `/v1/world`, never textured with its
aerial imagery. Trees, buildings, flames, smoke and the drone are the low-poly models in the repo's
`assets/` (`world/models.ts` loads them; Vite bundles the `.glb` files):

- **Ground**: coloured by the fire model's 10 m fuel classes (grass, shrub, tree, urban, structure,
  bare, water), blended across cells so edges are not blocky, with the OpenStreetMap roads at their
  paved width. Behind the fire front it chars; flames and embers are composited on it.
- **Trees**: ~115k individual trees, each one of the two models of its growth form, scaled to its
  surveyed height and crown radius, foliage tinted with its crown colour. Within 350 m of the
  camera they use the full model, farther out the `_lod1` one. They burn, scorch, or lose their
  foliage to a charred skeleton as the fire passes.
- **Buildings**: the 2,969 pre-fire footprints. Near-rectangular houses take the gable or hip house
  model, and rectangular shop-sized flat roofs the shop model, fitted to the footprint with roof and
  walls recoloured. A model is used only when it covers the footprint without much stretching
  (`placement` in `world/buildings.ts`); long rows, sheds, big halls and irregular outlines are
  extruded from their exact outline. Destroyed buildings burn, then collapse: modelled ones into the
  ruin model.
- **Fire**: per-cell timing evaluated every frame: flame models (tall on trees and buildings, a low
  spread on grass) that flicker, smoke puffs that rise, grow and fade downwind, and firelight.
- **Light**: sun position and colour for the scenario time; the town burns into the night after
  sunset (19:05 HST).

Always drawn: the drone (drawn six times life size so it reads from the orbit distance, rotor
blurs on, camera gimbal at the reported pitch), its camera's frustum and ground footprint (blue lines), and the
ground outline of each risk it reported, red for `on_fire` and yellow for `at_risk` (the readme's
colours), for 6 s after its frame.

"Can see" is tested per pixel, like a shadow map. Every frame the scene's depth is rendered from the
drone's camera (`world/visibility.ts`), and each world material whitens any point outside that
camera's frustum or farther than what the depth map holds there. Smoke and flames do not block the
view, and the drone model is never whitened.

## Drone data

With `--drone-info` set, the sim reads `ws://<drone-info>/v1/stream`: a `fleet` snapshot about once a
second, then `telemetry` (10 Hz) and `detections` (one per captured frame) for the chosen drone.

drone-info is not built yet, so without it the sim plays **dummy drone data**
(`src/droneInfo/dummy.ts`) behind the same interface:

- one drone, `dummy-1`, hovers at a fixed pose south of Front St looking north (`dummyDrone.ts`);
- their scenario time is Demo Data's clock (`PUT /v1/clock` to move or speed it up), and their
  detections are the thermal hotspots (600 K and hotter) Demo Data reports for a camera at the
  drone's pose, as `on_fire` outlines. There are no `at_risk` outlines in the dummy data.

## Layout

```
scripts/start.mjs   launcher: passes the launch settings and opens the window or a browser tab
src/
  app.ts            render loop, orbit camera, status line
  launch.ts         launch settings from the Tauri shell or the URL
  droneInfo/        Drone Info client, dummy stand-in, message validation, the drone's track
  world/            world assets and models, ground shader, vegetation, buildings, fire, light,
                    visibility
  view/             drone camera (pose -> Three.js camera), drone model and outlines
src-tauri/          Tauri 2 shell: the window, and the launch settings handed to it
```

Checks: `pnpm --filter @ember/drone-sim typecheck | test | build`. `lint` and `format:check` run clippy
and rustfmt on the shell.
