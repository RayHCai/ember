# @ember/drone-runtime

The software that runs on one drone. It pairs with its edge-connector. On `start_mapping` it takes
off and maps everything inside the edge server's connectivity radius, together with the other
drones of the run. It runs risk detection on every camera frame and reports telemetry and
georeferenced detections up. When the area is mapped, the run is stopped or a failsafe trips, it
flies back to where it took off and lands.

## Contract

- **Edge link:** a WebSocket to the edge-connector at `/v1/drone`, with the shapes in
  `packages/contracts/src/droneLink.ts` (`link/messages.py` mirrors them).
  - Up: `hello` on every connect, then `telemetry`, `detections` (as in `droneInfo.ts`),
    `mission_status` and `swarm`.
  - Down: `welcome`, `start_mapping`, `stop_mapping`, and `swarm` messages relayed from the other
    drones of the run.
- **Swarm:** drones talk to each other only through the connector.
  - Positions and goals are in the mission frame (metres east/north/up of the edge server).
  - Coverage is cell indices of the grid the mission defines.
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
| Detection | Boxes from the detector are projected onto the surface they show and sent up as ground outlines. | `perception/` |
| Failsafes | Returns home when coverage reaches 97 %, on `stop_mapping`, when battery nears what the trip home needs plus 15 %, or after 20 s without the edge link. | `mission.py` |

## Detection

`--detector auto` (default) runs YOLO when a model is configured, fused with the thermal baseline;
otherwise the baseline runs alone.

- **Baseline** (`perception/heuristic.py`):
  - Thermal above 450 K is `on_fire`; 335-450 K is `at_risk`.
  - Without thermal, flame colours count as `on_fire`.
  - It cannot see dry fuel or smoke.
- **YOLO** (`perception/yolo.py`): an Ultralytics YOLOv8/11 model exported to ONNX, run with ONNX
  Runtime so it works on a Raspberry Pi.
  - Class names come from the model metadata and map to a risk by keyword: fire/flame are
    `on_fire`; smoke, ember, dry fuel and at-risk are `at_risk`.
  - Install with `uv sync --all-packages --extra yolo` and point `EMBER_YOLO_MODEL` (or
    `--yolo-model`) at the `.onnx`.
  - No weights ship with the repo yet.

Detectors only see pixels, so the same model works on oblique, horizon and nadir views.

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

# One simulated drone for a real edge-connector
uv run --package ember-drone-runtime drone-runtime run --id drone-1 --edge ws://localhost:8070/v1/drone
```

| Variable | Default | Meaning |
|---|---|---|
| `EMBER_DRONE_ID` | `drone-1` | Drone id sent in `hello` |
| `EMBER_EDGE_URL` | `ws://localhost:8070/v1/drone` | Edge-connector link |
| `EMBER_SENSOR_URL` | `ws://localhost:8090/v1/stream` | Sensor stream for `--camera sensor-stream` |
| `EMBER_YOLO_MODEL` | unset | ONNX model; enables YOLO under `--detector auto` |

`lockstep.py` runs the same brains without an event loop, for tests and quick experiments.
