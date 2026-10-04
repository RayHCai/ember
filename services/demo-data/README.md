# Demo Data

Serves simulated drones what a camera over **Lahaina, Maui** would have seen at any moment of the **August 8–9, 2023 fire**. You send a drone pose (lat, lon, altitude, heading, camera pitch) and a scenario time, and you get back:

- RGB and thermal frames.
- The exact ground footprint of the frame.
- Thermal hotspots located on the ground.
- Buildings in view.
- Weather and satellite fire detections up to that time.
- Optionally, ground-truth labels: no risk, at risk, on fire, smouldering, burned.

Before and after the fire, the frames are real aerial and satellite imagery. During the fire, they are synthesized from a fire-spread model calibrated to the real 911 and dispatch timeline. No sub-meter imagery exists of Lahaina while it was burning.

## Quick start

```bash
cd services/demo-data
uv sync
uv run demo-data download   # ~270 MB into ../../data, a few minutes
uv run demo-data build      # fire model, imagery co-registration and the 3D world, ~3 min
uv run demo-data verify     # georeferencing and model checks -> data/verify/report.json
uv run demo-data serve      # http://localhost:8090, interactive docs at /docs
uv run demo-data serve --host 0.0.0.0   # reachable from other machines (drones, a LAN viewer)
uv run demo-data serve --speed 30 --start 2023-08-08T15:00   # the town burns in minutes
```

Look at one spot across the whole fire (RGB | thermal | labels):

```bash
uv run demo-data timeline --lat 20.8790 --lon -156.6760 --out timeline.png
uv run demo-data render --lat 20.8725 --lon -156.6772 --alt 150 --t 2023-08-08T17:30 --out frame
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `EMBER_DATA_DIR` | `<repo>/data` | Where downloaded and derived data lives |
| `EMBER_CLOCK_START` | `2023-08-08T14:30-10:00` | Scenario time the clock starts at (`serve --start`) |
| `EMBER_CLOCK_SPEED` | `1` | Scenario seconds per wall-clock second, up to 3600 (`serve --speed`) |
| `EMBER_DEMO_DATA_ORIGINS` | none | Browser origins allowed besides localhost and the Tauri webview, comma-separated |

## What the drone sees, by time (HST)

| Scenario time | Imagery | Real or synthetic |
|---|---|---|
| before 06:34 Aug 8 | Esri Wayback (Maxar WorldView-2, Feb 2020, 0.5 m) | real |
| 06:34 Aug 8 – 11:20 Aug 9 | Pre-fire imagery ahead of the fire, real post-fire imagery behind it, with flames, embers, smoke and night lighting | **synthetic** |
| 11:20 Aug 9 – 11:12 Aug 12 | Maxar WorldView-2, Aug 9 11:20 (0.74 m, real smoke plumes) | real |
| 11:12 Aug 12 – Aug 14 | Maxar WorldView-2, Aug 12 (0.52 m) | real |
| Aug 14 onward | WaldoAir aerial survey (10 cm) over the burn, Maxar elsewhere | real |

Every observation states its epoch in `imagery.name` and `imagery.synthetic`.

### How the fire is synthesized

All of these inputs are real:

- **Burn scar:** Sentinel-2 burn-severity difference (Aug 3 vs Aug 13) inside the official WFIGS perimeter, giving 1,865 burned acres.
- **Ignition:**
  - The morning fire at 06:34.
  - The rekindle at 14:52 at the end of Kuʻialua St (ATF/MFD report; FSRI timeline).
- **Fuels:** ESA WorldCover land cover plus 2,969 pre-fire building footprints (OpenStreetMap as of 2023-08-07, gaps filled from Microsoft footprints).
- **Timing:** 50 fire sightings hand-picked from the FSRI timeline (e.g. "the big banyan tree is on fire", 16:24) and geocoded against OpenStreetMap. They are listed with quotes in `src/ember_demo_data/scenario/anchors.csv`, built by `scripts/build_anchors.py`.

How those inputs are combined:

- A wind-driven (east-north-easterly), shortest-travel-time spread model gives each 10 m cell an arrival time.
- Local spread speeds are tuned until the model agrees with the sightings.
- Sightings the main front can't explain become isolated spot fires.
- Flames and embers sit on the 2 m building footprints, smoke plumes drift downwind, and lighting follows the real sun position (sunset is about 19:05).

How well it matches the record:

| Check | Result |
|---|---|
| Sightings | 35 of 37 sightings explained by the front have fire present by the report time; median timing error 22 min. The other 13 sightings: 11 are spot fires, 3 fall outside the burnable area (e.g. Mala Wharf is a pier). |
| GOES-18 timing | Real fire intensity first detected 15:21 and peaked at 16:46; the model peaks at 16:51. Correlation 0.72. |
| Buildings | 2,127 of 2,969 pre-fire buildings end up destroyed, against roughly 2,200 structures reported. |

## Location guarantees

- **Coordinates:** all positions are WGS84 latitude/longitude in degrees. Lahaina longitudes are **negative**.
- **No silent substitution:** a position outside the coverage box (lat 20.838–20.915, lon −156.695 to −156.640) is rejected with HTTP 422 or a WebSocket error, never answered with somewhere else's data. The message names the likely mistake: swapped lat/lon, a flipped longitude sign, or the distance from Lahaina.
- **Explicit times:** times must carry a UTC offset (`2023-08-08T16:30:00-10:00`). A time without an offset is rejected, not guessed.
- **Georeferenced frames:** every frame returns `georef.center_ground` and `georef.footprint`, the lat/lon the image actually shows.
  - Rays use an exact azimuthal-equidistant projection centred on the drone.
  - A fitted fast path is checked against that exact projection every frame and falls back to it if the error exceeds 1 mm.
  - A nadir frame's centre maps back to the drone's own position.
- **Imagery co-registration:** every imagery layer is co-registered to Maxar Aug 12, which agrees with Sentinel-2 to 0.3 m. Measured shifts (Maxar Aug 9 was 12.5 m off) are corrected at read time. `demo-data verify` checks layers against each other and against Sentinel-2:

  | Check | Result |
  |---|---|
  | Layer-to-layer residual after correction | 0.4–0.9 m |
  | Every layer vs Sentinel-2 (10 m pixels) | ≤ 4.2 m |
  | Camera pixel → lat/lon → pixel round trip | 0.000 px error |
  | Rasterized perimeter vs published acreage | 0.09% |

- **No future leakage:** context feeds only return what existed at the requested time. That means GOES scans completed by then, polar-orbiter passes before then, and dispatch reports up to then. Ground truth is only included when you ask for `truth=true`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/scenario` | Coverage box, timeline, imagery layers (capture dates, licenses), class ids, clock |
| GET/PUT | `/v1/clock` | Scenario clock: `{"scenario_time": "...", "speed": 60, "paused": false}` |
| GET | `/v1/observation` | One observation (JSON, images base64). Query: `lat, lon, alt_m, heading_deg, pitch_deg, t, width, height, hfov_deg, thermal_width, images=rgb,thermal,labels, truth` |
| GET | `/v1/frame/{rgb.jpg,thermal.png,thermal_preview.png,labels.png}` | Single image for quick viewing; georeference in `X-Ember-*` headers |
| WS | `/v1/stream` | Drone sensor stream (below) |
| GET | `/v1/tiles/{layer}/{z}/{x}/{y}.jpg` | XYZ tiles: raw layers (`pre_2020`, `maxar_20230809`, `maxar_20230812`, `waldo_20230814`) or `scene?t=...` (the rendered view at time t, for draping in the Three.js sim or a dashboard) |
| GET | `/v1/truth/fire?t=&format=geojson\|summary` | Whole-area fire state as lat/lon polygons per class (ground truth) |
| GET | `/v1/context/weather?t=` | Kahului ASOS observation, fire-driving wind direction, Red Flag Warning status |
| GET | `/v1/context/satellite?lat=&lon=&t=` | Real GOES-18 (5 min, 2 km) and VIIRS/MODIS detections near the drone |
| GET | `/v1/context/structures?lat=&lon=&radius_m=&t=&truth=` | Pre-fire buildings near a point (state only with `truth=true`) |
| GET | `/v1/context/reports?t=` | Geocoded FSRI fire sightings up to time t |
| GET | `/v1/world` | Manifest of the 3D reconstruction for the drone viewer (`apps/drone-sim`): frame, extent, asset URLs |
| GET | `/v1/world/{vegetation.bin,buildings.json,roads.json,fire.bin}` | Trees, buildings, roads and per-cell fire timing (below) |
| GET | `/v1/world/imagery/{pre,post}.jpg`, `.../{pre,post}/patch.jpg?x=&y=&size_m=&res_m=` | Ground imagery in the world frame: whole area at 2 m, or a sharper patch (extent in `X-Ember-Extent`) |

Omit `t` to use the scenario clock.

### WebSocket `/v1/stream`

```jsonc
// client -> server (all optional except pose)
{"type": "configure", "drone_id": "drone-1", "camera": {"width": 640, "height": 480, "hfov_deg": 84},
 "thermal_width": 320, "images": ["rgb", "thermal"], "truth": false, "rate_hz": 0}
{"type": "pose", "request_id": "42", "lat": 20.8790, "lon": -156.6760, "alt_m": 150,
 "heading_deg": 90, "pitch_deg": -60, "t": "2023-08-08T16:45:00-10:00"}   // t optional

// server -> client
{"type": "configured", "config": {...}, "clock": {...}}
{"type": "observation", "drone_id": "drone-1", "request_id": "42", "scenario_time": "...", "georef": {...},
 "imagery": {...}, "hotspots": [...], "environment": {...}, "satellite": {...}, "structures": {...},
 "images": {"rgb": {"format": "jpeg", "encoding": "base64", "data": "..."}, "thermal": {...}}}
{"type": "error", "code": "out_of_coverage" | "bad_time" | "bad_request", "message": "...", "request_id": "42"}
```

- **`rate_hz: 0` (default):** one observation per pose message. If poses arrive faster than frames render, only the latest pose is rendered.
- **`rate_hz > 0`:** the server pushes observations at that rate using the latest pose, following the scenario clock unless the pose pinned `t`.

### Observation contents

| Field | Contents |
|---|---|
| `images.rgb` | JPEG, 640×480 by default |
| `images.thermal` | 16-bit PNG in deci-kelvin (`kelvin = value / 10`), 320 px wide by default. Flames read 520–1200 K, smouldering debris 330–750 K, ground ~300 K, sky 235 K. Thermal sees through smoke. |
| `images.labels` | Palette PNG with `truth=true`: 0 no_risk, 1 at_risk, 2 on_fire, 3 smouldering, 4 burned, 5 water, 255 sky/no data |
| `hotspots` | Hot regions (>450 K) in the thermal frame with ground lat/lon, peak temperature, area and pixel bbox |
| `environment` | Weather, sun elevation, `is_night`, Red Flag Warning |
| `satellite` | Real satellite fire detections (see `/v1/context/satellite`) |
| `structures` | Buildings inside the footprint |
| `truth` | With `truth=true`: class fractions in view and whole-fire summary |

### World for the 3D viewer (`/v1/world`)

The Three.js sim rebuilds the scenario in 3D from these assets, all in one metric frame: x metres east
and y metres north of the coverage-box centre (`x = (lon - lon0) * m_lon`, `y = (lat - lat0) * m_lat`,
both constants in the manifest; ground flat at z = 0). The first request builds them (about 2
minutes; `demo-data world` does it ahead of time) and they are cached in `data/derived/world/`.

- **Trees** (`vegetation.bin`, float32 rows of `fields`). ESA WorldCover decides where trees may
  grow. The pre-fire imagery at 1 m decides where each one is: green, darker than open grass and
  textured, with stricter thresholds on grassland than in tree cover. Water, building footprints,
  named roads and bare ground never carry trees. Sunlit crown tops are packed into crowns, widest
  first, so a big canopy becomes a few broad trees and a thicket many small ones. Each tree gets:
  - a growth form (`broadleaf`, `conifer`, `palm`, `umbrella`, `shrub`) from land cover, crown
    size and distance to the sea;
  - a height from that form's allometry;
  - the imagery colour under its crown;
  - its cell's fire arrival and flame time;
  - `survives`, set when green canopy is still there in the post-fire imagery.
- **Buildings** (`buildings.json`): the pre-fire footprints with height from footprint size, a
  gable roof on near-rectangular houses, roof colour from the imagery, and the fire model's ignition
  time and fate.
- **Roads** (`roads.json`): the named OpenStreetMap roads as world-frame polylines, each with a paved
  width by road class (5 m service lanes to 14 m motorway).
- **Fire** (`fire.bin`): arrival, flame and smoulder minutes and heat per 10 m cell, resampled from
  the model grid, then the fuel class per cell, which the viewer colours the ground from. Rows run
  south to north. The viewer evaluates `model/state.py`'s curves from these on the fly.

## Limitations

- **Flat ground:** ground is flat at the drone's ground level (no terrain model). Nadir views are exact. Oblique views of the hills east of town are displaced by their height.
- **Old pre-fire imagery:** pre-fire imagery is from February 2020, the newest pre-fire capture Esri published for Lahaina.
- **Synthetic timing:** mid-fire visuals and timing are synthetic. They follow the real sequence at neighbourhood scale, not building by building.
- **Weather is not local:** the weather station is Kahului Airport (25 km away, windward side; West Maui has no archived station for the event). The fire model uses one east-north-easterly wind direction throughout.
- **Speed:** rendering takes about 0.8–1.5 s per observation (640×480 RGB plus 320×240 thermal) on a laptop CPU. Use a smaller `width`/`height` for faster frames.
- **Licenses:**
  - Maxar imagery is **CC BY-NC 4.0** (non-commercial only).
  - Esri Wayback is under Esri's terms.
  - The WaldoAir survey's license is not stated (released publicly via NOAA).
  - The Maui County drone survey (~2 cm) and EagleView imagery are publicly served but carry no stated license, so they are not included.
  - See `data/README.md`.

## Code layout

```
src/ember_demo_data/
  config.py        AOI, event timeline, imagery layers (capture dates, licenses)
  geo.py           tile math, UTM / local projections, position validation
  tiles.py         MBTiles storage, imagery sampling with co-registration
  ingest/          download steps (imagery tiles, Sentinel-2, perimeter, FSRI, weather, GOES, FIRMS, OSM)
  model/           burn scar, fuels, spread model + calibration (build.py), fire state at time t (state.py)
  render/          camera ray casting, compositor (flames/smoke/lighting/thermal), observation assembly
  context.py       weather, satellite detections, buildings
  api/             FastAPI app (REST + WebSocket), scenario clock, world assets (world.py)
  world/           3D reconstruction for the viewer: frame, vegetation, buildings, fire grid, imagery mosaics
  verify.py        co-registration and georeferencing checks
  scenario/anchors.csv   geocoded FSRI sightings that time the fire
```
