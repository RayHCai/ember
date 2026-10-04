# Raspberry Pi 5 as a drone

How to take a Raspberry Pi 5 from a fresh OS to a drone flying a mapping run: drone-runtime on the
Pi, paired with an edge-connector on another machine, taking camera frames from Demo Data and
reporting telemetry and detections.

The Pi has no flight controller or camera adapter yet (see `services/drone-runtime/README.md`). It
runs the real drone software with simulated flight, and its camera is either Demo Data's sensor
stream or the built-in synthetic world. Everything on the network is real: mDNS discovery, the
WebSocket link, the swarm messages and the uplink to edge-manager.

## Topology

```
              LAN (same subnet, so mDNS works)
 ┌──────────────── Pi 5 ────────────────┐      ┌──────────── Dev machine ─────────────┐
 │ drone-runtime run                    │─WS──▶│ edge-connector    :8070  /v1/drone    │
 │   --camera sensor-stream             │─WS──▶│ demo-data serve   :8090  /v1/stream   │
 └──────────────────────────────────────┘      │ edge-manager      :8060  (optional)   │
                                               │ drone-info        :4002  (optional)   │
                                               │ drone-sim app            (optional)   │
                                               └───────────────────────────────────────┘
```

- **Required:** edge-connector, for the drone to pair with. Demo Data, for real camera frames.
- **Optional:** edge-manager, drone-info and drone-sim, to watch the drone in 3D.

Each drone only talks to the edge-connector and the sensor stream. Nothing reaches the Pi directly.

## What you need

- A Raspberry Pi 5 (4 GB or more) with a 32 GB+ microSD card or NVMe drive, and the official 27 W
  power supply.
- **Raspberry Pi OS Lite (64-bit)**, Bookworm or newer. Use 64-bit: numpy, scipy and onnxruntime
  only ship prebuilt wheels for `aarch64`.
- A dev machine with the repo set up (`pnpm install && uv sync --all-packages`, Go installed).
- Both machines on the same LAN and subnet. Guest Wi-Fi and some corporate networks block mDNS and
  traffic between clients. If yours does, skip discovery and pass `--edge` (step 4).

## 1. Check the Pi

An existing Raspberry Pi OS install works. On the Pi (or over `ssh <user>@<hostname>.local`):

- `uname -m` must print `aarch64`. If it prints `armv7l`, the OS is 32-bit: reinstall with
  _Raspberry Pi OS (64-bit)_ in Raspberry Pi Imager, since numpy, scipy and onnxruntime have no
  32-bit wheels.
- `ping DEV_IP` must reach the dev machine (its address is found in step 2).
- The hostname is the default drone id (`drone-<hostname>`) unless you pass `--id`.

## 2. Start Demo Data on the dev machine

Demo Data renders what a camera over Lahaina would see for any pose. Build its data once:

```bash
cd services/demo-data
uv run demo-data download    # ~270 MB into ./data
uv run demo-data build       # ~3 min
```

Then serve it on all interfaces so the Pi can reach it, starting the clock just before the rekindle:

```bash
uv run demo-data serve --host 0.0.0.0 --start 2023-08-08T14:45
```

- Open `http://localhost:8090/control` and press play. Every drone and viewer shares this one
  scenario clock. At 60x, fire appears near the drone's default home within minutes.
- Find the dev machine's LAN address (`ipconfig` on Windows, `ip -4 addr` on Linux,
  `ipconfig getifaddr en0` on macOS). This guide calls it `DEV_IP`.
- From the Pi, `curl http://DEV_IP:8090/v1/scenario` must answer JSON. If it times out, allow inbound
  TCP 8090 and 8070 in the dev machine's firewall (on Windows, accept the prompt for a private
  network or add a rule in _Windows Defender Firewall_).

## 3. Start the edge-connector on the dev machine

Run it natively from the repo root, not in Docker. In `compose.yaml` the connector sits on a Docker
network, so its mDNS announcement never reaches the LAN.

```bash
go run ./services/edge-connector/cmd
```

- It listens on `:8070`, announces `_ember-edge._tcp` over mDNS, and logs its edge server id
  (`edge-<hex>`). Note it if more than one connector is on the network.
- Without `EMBER_EDGE_KEY` it accepts unauthenticated tasks and logs a warning. Fine on a dev LAN.
- It retries its uplink to edge-manager in the background. It serves drones without edge-manager.

From the Pi, `curl http://DEV_IP:8070/healthz` must succeed.

## 4. Set up the Pi

Clone the repo on the Pi and run the setup script. Point it at the dev machine's sensor stream:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/RayHCai/ember.git ~/ember
cd ~/ember
bash scripts/setup-pi.sh --id drone-1 --sensor-url ws://DEV_IP:8090/v1/stream
```

`scripts/setup-pi.sh` does the following:

1. **System packages:** installs Avahi (mDNS), OpenBLAS, chrony and build tools.
2. **Python:** installs `uv` and Python 3.12, then only the `ember-drone-runtime` package, not the
   whole workspace.
3. **Config:** writes `services/drone-runtime/drone.env` (gitignored).
4. **Discovery check:** browses for edge servers for 5 s and prints any it finds. Seeing the
   dev machine's connector here means discovery will work.
5. **Service:** installs and starts the `ember-drone` systemd service, which runs
   `drone-runtime run` on boot and restarts it on failure.

| Option                                    | Use it when                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `--edge ws://DEV_IP:8070/v1/drone`        | mDNS is blocked on your network, or you want a fixed connector                         |
| `--edge-id edge-<hex>`                    | several connectors announce on the LAN; pair with this one only                        |
| `--sensor-url ws://DEV_IP:8090/v1/stream` | frames from Demo Data. Omit it for the synthetic camera, which needs no Demo Data      |
| `--yolo-model /path/model.onnx`           | run a model other than the checkout's `fire-seg-v1`. Models come from `tools/fire-seg` |
| `--no-service`                            | install only; run it by hand (below)                                                   |
| `--ref <branch>`                          | deploy a branch other than `master`                                                    |

To run it in the foreground instead of as a service, for debugging:

```bash
sudo systemctl stop ember-drone
cd ~/ember && set -a && . services/drone-runtime/drone.env && set +a
uv run --package ember-drone-runtime --no-sync drone-runtime run --camera sensor-stream
```

## 5. Check that the drone paired

On the Pi:

```bash
journalctl -u ember-drone -f
```

Expect the drone to find the edge (or use the URL you gave), connect, send `hello` and get
`welcome`. The edge-connector's log shows the drone pairing. The drone then idles on the ground and
keeps the link up until a run starts. If the link drops it reconnects on its own, browsing mDNS
again each time.

## 6. Start a mapping run

The connector starts a run when it gets a `start_mapping` task. Normally that comes from the
dashboard, through api and edge-manager. To test the drone alone, send it to the connector
yourself from the dev machine:

```bash
curl -X POST http://localhost:8070/v1/tasks -H 'Content-Type: application/json' -d '{
  "kind": "start_mapping",
  "mission": {
    "runId": "pi-test-1",
    "zoneId": "lahaina",
    "edgeServer": { "lat": 20.8838, "lng": -156.6670 },
    "connectivityRadiusM": 300,
    "boundary": null,
    "cellSizeM": 10,
    "altitude": { "minM": 60, "maxM": 90 }
  }
}'
```

- The answer is `{ "runId": "pi-test-1", "drones": ["drone-1"] }`: every connected drone joins.
  `409` means no drone is connected, or another run is still active.
- `edgeServer` must sit near the drone's home. The default home is `20.8838,-156.6670`, inside Demo
  Data's coverage box. If you change it with `--home`, keep it inside lat 20.838–20.915, lon
  −156.695 to −156.640, or Demo Data rejects every frame as `out_of_coverage`.
- The shape is `ConnectorTask` in `packages/contracts/src/edge.ts`.

Once the drone has the mission it:

1. takes off and flies its tiles of the 300 m disc;
2. sends each pose to Demo Data and gets RGB and thermal frames back, at most two a second;
3. runs detection on every frame and sends up `telemetry`, `mission_status`, `swarm` coverage and
   confirmed `detections`, all over the edge link;
4. flies home and lands at 97 % coverage, on a low battery, after 20 s without the edge link, or on
   a stop:

```bash
curl -X POST http://localhost:8070/v1/tasks -H 'Content-Type: application/json' \
  -d '{ "kind": "stop_mapping", "runId": "pi-test-1" }'
```

The run is done once every drone in it has reported `landed`. Then you can start the next one.

## 7. Watch it (optional)

To see the Pi's drone in 3D, run the rest of the drone pipeline on the dev machine. Each piece has
a default address that points at the next, so start them in this order:

```bash
pnpm --filter @ember/drone-info build && node services/drone-info/dist/main.js   # :4002
go run ./services/edge-manager/cmd                                                # :8060
pnpm --filter @ember/drone-sim start --drone drone-1
```

- edge-connector's uplink reaches edge-manager by itself (`EMBER_EDGE_MANAGER_URL` defaults to
  `http://localhost:8060`).
- edge-manager forwards hellos, telemetry and detections to drone-info.
- drone-sim follows `drone-1` from drone-info and draws what it sees on Demo Data's world.
- edge-manager also tries to record runs in the api on `:4001`. Without the api it logs errors and
  keeps forwarding. Set `EMBER_API_URL=` to turn recording off.

## More drones

Repeat step 4 on each Pi with its own `--id`. Every connected drone joins the next run, and the
drones share the area through the connector. To grow the swarm without more hardware, add simulated
drones on the dev machine. They map, detect and share coverage with the Pi like any other drone:

```bash
uv run --package ember-drone-runtime drone-runtime fleet --drones 2 --edge ws://localhost:8070/v1/drone --camera sensor-stream
```

The compose stack already runs these two as `drone-fleet` (`sim-1` Osprey, `sim-2` Harrier). Point
the Pi at it with `--edge ws://DEV_IP:8070/v1/drone`, since mDNS does not leave Docker's network.

## Three-machine demo

The full demo split across hardware: a laptop runs the stack, a Mac Mini is the edge server, and a
Pi is the drone. No simulated drones fly.

| Machine  | Runs                                                                            | Command                                                |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Laptop   | compose without `edge-connector` and `drone-fleet`, the dashboard and drone-sim | `pnpm demo:laptop`                                     |
| Mac Mini | edge-connector, natively so it announces over mDNS                              | `bash scripts/run-edge.sh --manager LAPTOP_IP`         |
| Pi       | drone-runtime, which finds the Mac Mini over mDNS                               | `bash scripts/setup-pi.sh ...` (printed by the laptop) |

1. On the laptop, build Demo Data's scenario once (step 2), then run `pnpm demo:laptop`. It stops
   any local edge-connector and sim drones, starts the rest, and prints its LAN address and the
   exact Mac Mini and Pi commands. Pass `--host-ip` if it guesses the address wrong, or
   `--drone ID` to follow a drone other than `drone-pi`.
2. On the Mac Mini (Go installed, repo cloned), run the printed `run-edge.sh` command. It builds
   the connector, checks it can reach the laptop's edge-manager, and keeps its edge server id in
   `.demo/edge-connector.db`. Allow incoming connections when macOS asks.
3. On the Pi, run the printed `setup-pi.sh` command. `--home` puts the drone at the demo zone's
   edge site, and `--sensor-url` points its camera at the laptop's Demo Data.
4. Once the drone pairs, the laptop assigns the Mac Mini to the demo zone and opens the dashboard
   and drone-sim. Start a scan from the dashboard.

The laptop must accept inbound TCP 8060 (edge-manager) and 8090 (Demo Data), and the Mac Mini 8070. The edge key defaults to compose's `local-dev-edge-key` on both sides. If `.env` sets
`EMBER_EDGE_KEY`, the printed Mac Mini command carries it. All three machines need one subnet that
allows mDNS and client-to-client traffic. On a network that blocks them, add
`--edge ws://MAC_MINI_IP:8070/v1/drone` to the Pi command.

### Screens

`pnpm demo:laptop` serves the dashboard (`:5173`) and drone-sim (`:5180`) from Vite and opens both
as browser tabs, with the full URLs printed in its output. To put the dashboard on the laptop and
drone-sim on an external monitor:

1. Extend the desktop to the monitor (Win+P on Windows, _Displays_ settings on macOS), rather than
   mirroring it.
2. Drag the drone-sim tab out into its own window, move it to the monitor and make it fullscreen
   (F11). Make the dashboard fullscreen on the laptop.

For windows without tabs or an address bar, close the opened tabs and open each printed URL as a
Chrome app window instead. `--window-position` is the monitor's offset in the OS display layout, so
it is negative when the monitor sits left of the laptop:

```bash
chrome --new-window --app="SIM_URL" --window-position=1920,0 --start-fullscreen
```

### Leaving the Mac Mini and Pi set up

Between demos, the Mac Mini and Pi need no setup again.

- **Mac Mini:** `run-edge.sh` runs in the foreground, not as a service. Leave it running. After a
  reboot, run it again.
- **Pi:** the `ember-drone` service starts on boot and retries the edge link until it pairs, so
  power it on in any order relative to the Mac Mini. It needs no screen or keyboard.
- **Pi network:** it must join the network by itself on boot. Save the hotspot's Wi-Fi details
  beforehand (`sudo nmcli dev wifi connect "SSID" password "PASSWORD"`) and keep the hotspot's name
  and password fixed.
- **Laptop address:** `--sensor-url` is written into `services/drone-runtime/drone.env`. If the
  laptop's LAN address changes, the drone still pairs but gets no camera frames: re-run the printed
  `setup-pi.sh` command. With `--tailscale` the laptop's address is stable and this does not arise.
- **Pi power:** use a 27 W USB-C PD supply or PD power bank, since weaker ones throttle the Pi 5.
  Shut it down with `sudo poweroff` before unplugging to protect the SD card.

### Laptop on another network

When the laptop is on venue Wi-Fi and the Mac Mini and Pi share a phone hotspot, nothing can dial
across the two networks. Put all three on one Tailscale tailnet and run `pnpm demo:laptop
--tailscale`. The printed commands then use the laptop's Tailscale address, and include the Pi's
Tailscale install.

- **Laptop and Mac Mini:** over Tailscale, both ways. The Mac Mini dials edge-manager, and
  edge-manager, in Docker, dials the connector at the address the connector reports: its own
  Tailscale address, since that is the route to the laptop.
- **Mac Mini and Pi:** over the hotspot. Discovery still uses mDNS there. If the hotspot drops
  multicast, add `--edge ws://MAC_MINI_TAILSCALE_IP:8070/v1/drone` to the Pi command.
- **Pi and laptop:** over Tailscale, for Demo Data's frames. A relayed (DERP) path makes frames
  lag. `tailscale ping LAPTOP` on the Pi shows whether the path is direct.

## Troubleshooting

| Symptom                                         | Cause and fix                                                                                                                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery finds nothing                         | No connector is announcing on this subnet: it runs in Docker, mDNS is blocked, or the machines are on different subnets. Pass `--edge ws://DEV_IP:8070/v1/drone`. `avahi-browse -rt _ember-edge._tcp` on the Pi shows what is announced. |
| Connects, then drops every few seconds          | The dev machine's firewall or Wi-Fi power saving. Allow 8070, and try Ethernet on the Pi.                                                                                                                                                |
| `out_of_coverage` errors from the sensor stream | Home or `edgeServer` is outside Demo Data's box (see step 6).                                                                                                                                                                            |
| No detections                                   | The scenario clock is before the fire, or paused. Use `/control` to jump to 15:00–17:00 Aug 8.                                                                                                                                           |
| Frames lag                                      | Demo Data renders a frame in about 1 s on a laptop CPU. One Pi is fine. Many drones on one Demo Data slow everyone down.                                                                                                                 |
| `409` on start                                  | No drone is connected, or a run is active. Stop it, or wait for every drone to land.                                                                                                                                                     |
| `uv sync` builds numpy from source              | You are on 32-bit Raspberry Pi OS. Reflash with 64-bit.                                                                                                                                                                                  |
| Telemetry timestamps look off                   | The Pi's clock is wrong. `chronyc tracking` should show it in sync. The Pi 5 has no RTC battery by default.                                                                                                                              |

## Updating the Pi

```bash
bash ~/ember/scripts/setup-pi.sh --id drone-1 --sensor-url ws://DEV_IP:8090/v1/stream
```

Re-running the script pulls the latest `--ref`, re-syncs dependencies, rewrites `drone.env` and
restarts the service.
