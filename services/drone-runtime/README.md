# @ember/drone-runtime

The software that runs on one drone. It pairs with its edge-connector. On `start_mapping` it takes
off and maps everything inside the edge server's connectivity radius, together with the other
drones of the run. It runs risk detection on every camera frame and reports telemetry and
georeferenced detections up. When the area is mapped, the run is stopped or a failsafe trips, it
flies back to where it took off and lands.

## Contract

- **Finding the edge:** with `--edge auto` (the default without `EMBER_EDGE_URL`) the drone browses
  mDNS for `_ember-edge._tcp` before every connect and takes the first edge server that answers, or
  only the one named by `--edge-id`. It prefers the announcement's IPv4 address.
- **Edge link:** a WebSocket to the edge-connector at `/v1/drone`, with the shapes in
  `packages/contracts/src/droneLink.ts` (`link/messages.py` mirrors them).
  - Up: `hello` on every connect, then `telemetry`, `detections` (as in `droneInfo.ts`),
    `mission_status` and `swarm`.
  - Down: `welcome`, `start_mapping`, `stop_mapping`, and `swarm` messages relayed from the other
    drones of the run.
- **Swarm:** drones talk to each other only through the connector.
  - Positions and goals are in the mission frame (metres east/north/up of the edge server).
  - Coverage is cell indices of the grid the mission defines, with the fire evidence the drone's own
    frames added to cells since its last coverage message.
  - Every drone runs the same Hungarian assignment of drones to unmapped tiles over that shared
    state and flies its own row. There is no leader.
- **Outbound civilian alerts:** none. This service only reports detections.

## How a drone flies a run

| Step | What happens | Code |
|---|---|---|
| Altitude band | Each drone of the run cruises at its own height in the mission's band (60, 70, 80 m...), so most pairs never share an altitude. | `mission.py` |
| Goals | The area is cut into tiles about one camera footprint wide. Unmapped tiles are assigned across the swarm; a drone's current tile is discounted so goals do not flap. | `swarm/goals.py` |
| Paths | Straight unless something taller than the band allows is in the way, then A* over the height map. Altitude follows the terrain and climbs early for tall things ahead. | `nav/path.py` |
| Avoidance | Each peer is predicted at constant velocity; the drone bends away from any it would pass closer than 15 m within 6 s. Vertical gaps count double. | `nav/avoid.py` |
| Geofence | Never leaves the connectivity radius minus a 30 m margin. | `nav/avoid.py` |
| Mapping | Each frame is folded into a 2.5D grid (coverage, ground, surface top, risk). With depth (LiDAR) every pixel is a 3D point; without it, rays hit the ground estimate. | `mapping/` |
| Detection | Region outlines from the detectors (or boxes) are projected onto the surface they show, folded into per-cell fire evidence, and sent up as ground outlines once confirmed. | `perception/`, `mapping/evidence.py` |
| Failsafes | Returns home when coverage reaches 97 %, on `stop_mapping`, when battery nears what the trip home needs plus 15 %, or after 20 s without the edge link. | `mission.py` |

## Detection

`--detector auto` (default) runs YOLO when a model is configured, fused with the thermal baseline;
otherwise the baseline runs alone. Each detection is a region with an outline in camera pixels,
traced along pixel edges (`perception/outline.py`, at most 32 points, clockwise from its top-left).
Without a mask the outline is the box.

- **Baseline** (`perception/heuristic.py`):
  - Thermal above 520 K is `on_fire`. Flames read 520-1200 K, and smouldering debris below that
    is `at_risk`.
  - Above 335 K and at least 20 K over the local background (median of the cooler pixels nearby)
    is `at_risk`, so sun-baked ground is not a front.
  - Confidence grows with peak temperature and with area (63 % of its peak at 12 sensor pixels),
    so a few hot pixels are weak evidence.
  - Without thermal, flame colours count as `on_fire`, at most 0.6.
  - It cannot see dry fuel or smoke.
- **YOLO** (`perception/yolo.py`): an Ultralytics YOLOv8/11 export in ONNX, run with ONNX Runtime
  so it works on a Raspberry Pi. The model is built by `tools/fire-seg`.
  - Class names come from the model metadata and map to a risk by keyword: fire/flame are
    `on_fire`; smoke, ember, burned, dry fuel and at-risk are `at_risk`.
  - Segmentation exports give each region a mask, decoded exactly as Ultralytics does. Its outline
    is what gets georeferenced, and the confidence is the class score times the mean mask
    probability inside it. Detection exports give boxes.
  - Install with `uv sync --all-packages --extra yolo` and point `EMBER_YOLO_MODEL` (or
    `--yolo-model`) at the `.onnx`.
- **Fusion** (`FusedDetector`): within a frame, overlapping regions of one risk merge. Their
  confidences combine as independent evidence, and the most confident region's outline is kept.

Detectors only see pixels, so the same model works on oblique, horizon and nadir views.

### Evidence and confirmation

Detections are not reported as they come. `mapping/evidence.py` keeps per-cell log-odds that a
cell is `on_fire` and that it is `at_risk`:

| Event | Effect on a cell's log-odds |
|---|---|
| A detection's ground outline covers it | `+ 3.5 x confidence`; overlapping detections in one frame do not stack |
| The frame saw it and found no region of that risk there | `- 0.7` |
| A peer's coverage message carries evidence for it | that drone's own delta is added |

Values stay between the prior (5 %) and a ceiling. Because the floor is the prior, a cell that
looked clear for a long time still confirms a strong new detection at once; fires ignite. A
detection is sent up only when the mean posterior of its cells reaches 0.5, and that posterior
replaces its confidence. In practice:

- A large hot blob confirms in one frame.
- A 0.4 RGB detection needs three frames from one drone, or fewer when peers see it too.
- A one-frame blip fades without ever being reported.
- A fire that burns out drops below the line within about four seconds.

The numbers are `EvidenceParams` in `FlightParams.evidence`.

## Adapters

The core (`mission.py`, `MissionBrain`) is synchronous and knows only these protocols:

| Protocol | Implementations |
|---|---|
| `FlightController` (`flight/`) | `SimulatedFlight`: point mass with acceleration limits and battery drain |
| `Camera` (`sensors/`) | `SensorStreamCamera`: any server speaking Demo Data's `/v1/stream`; `SyntheticCamera`: ray-marched procedural world with RGB, thermal and depth |
| `Detector` (`perception/`) | `HeuristicDetector`, `YoloDetector`, `FusedDetector` |
| `Link` (`link/`) | `EdgeLink`: reconnecting WebSocket; `LocalHub`: in-process connector for simulation |

There is no physical flight controller, Pi camera or LiDAR adapter yet.

## Run

```bash
# N drones around an in-process edge, 5x real time, synthetic 3D world (no other services needed)
uv run --package ember-drone-runtime drone-runtime swarm-sim --drones 4 --radius 400

# Same, with frames from Demo Data (start it first: services/demo-data, `demo-data serve`)
uv run --package ember-drone-runtime drone-runtime swarm-sim --camera sensor-stream --time-scale 1

# Watched in drone-sim: report to drone-info (implies the Demo Data camera and real time)
uv run --package ember-drone-runtime drone-runtime swarm-sim --drone-info http://localhost:4002

# One simulated drone for a real edge-connector, found over mDNS on the local network
uv run --package ember-drone-runtime drone-runtime run --id drone-1

# Same, for a given connector
uv run --package ember-drone-runtime drone-runtime run --id drone-1 --edge ws://localhost:8070/v1/drone

# Two simulated drones (sim-1 Osprey, sim-2 Harrier) in one process for that connector
uv run --package ember-drone-runtime drone-runtime fleet --drones 2 --edge ws://localhost:8070/v1/drone --camera sensor-stream
```

`fleet` is `run` several times over in one process: each drone has its own edge link, camera and
flight, so the connector sees separate drones that join the same runs as any other, a Pi included.
They share one detector and take off on a 12 m ring around `--home`.

On a Raspberry Pi (64-bit OS), `scripts/setup-pi.sh --id drone-1 [--edge ws://HOST:8070/v1/drone]` installs
uv and this package, writes `services/drone-runtime/drone.env` and runs `run` as the `ember-drone`
systemd service. Without `--edge` it finds the edge server over mDNS. `docs/raspberry-pi.md` walks
through a whole Pi 5 deployment.

| Variable | Default | Meaning |
|---|---|---|
| `EMBER_DRONE_ID` | `drone-1` | Drone id sent in `hello` |
| `EMBER_EDGE_URL` | `auto` | Edge-connector link, or `auto` to find one over mDNS |
| `EMBER_EDGE_ID` | unset | With `auto`, connect only to this edge server id |
| `EMBER_SENSOR_URL` | `ws://localhost:8090/v1/stream` | Sensor stream for `--camera sensor-stream` |
| `EMBER_YOLO_MODEL` | unset | ONNX model; enables YOLO under `--detector auto` |
| `EMBER_DRONE_INFO_URL` | unset | `swarm-sim --drone-info`: post reports to drone-info for viewers |

`swarm-sim` centres on the fire's path west of the Kuialua St rekindle (20.8838, -156.6670) unless
given `--center`. A drone takes at most two frames a second (scaled with `--time-scale`), the pace
of an on-board detector. With `--drone-info`, the in-process edge posts what drones report to
drone-info's `/v1/ingest`, standing in for edge-connector and edge-manager.

`lockstep.py` runs the same brains without an event loop, for tests and quick experiments.
