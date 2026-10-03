# data/

Data for the Demo Data service (`services/demo-data`). It is all regenerable:

```bash
uv run demo-data download && uv run demo-data build && uv run demo-data verify
```

Commands run from `services/demo-data`. Total size is about 270 MB.

## tiles/: imagery (MBTiles, TMS row order, one file per layer)

| File | Source | Capture | Resolution | Zooms | License |
|---|---|---|---|---|---|
| `pre_2020.mbtiles` | Esri World Imagery Wayback, release 47963 (2023-06-29) | Maxar WorldView-2, 2020-02-20 | 0.5 m | 13–18 | Esri terms of use |
| `maxar_20230809.mbtiles` | Maxar Open Data (catalog 10300100EB592000), via NOAA NGS tiles | 2023-08-09 11:20 HST, 38° off-nadir | 0.74 m | 13–18 | CC BY-NC 4.0 |
| `maxar_20230812.mbtiles` | Maxar Open Data (catalog 10300100EB15FF00), via NOAA NGS tiles | 2023-08-12 11:12 HST | 0.52 m | 13–18 | CC BY-NC 4.0 |
| `waldo_20230814.mbtiles` | WaldoAir aerial survey, via NOAA NGS Emergency Response Imagery | 2023-08-14 (time not published) | 0.10 m | 13–19 | Not stated; check before redistributing |

Open any of these in QGIS to check them against a basemap.

## raw/: other source data

| File | Source | License |
|---|---|---|
| `wfigs_lahaina_perimeter.geojson` | NIFC WFIGS Interagency Perimeters, Lahaina 2023-HIMAUX-000775 (2,123.5 ac) | Public domain |
| `fsri_timeline.csv` | UL FSRI Lahaina Fire Comprehensive Timeline, Phase 1 dataset (12,140 rows) | CC BY-SA 4.0 |
| `sentinel2/S2_2023080{3,8}.tif`, `S2_20230813.tif` | Sentinel-2 L2A reflectance (Earth Search), resampled to the 10 m UTM 4N analysis grid | Copernicus open data |
| `worldcover_2021.tif` | ESA WorldCover 2021 v200, on the analysis grid | CC BY 4.0 |
| `buildings_osm_20230807.geojson` | OpenStreetMap buildings as of 2023-08-07 (Overpass attic query) | ODbL |
| `buildings_microsoft.geojson` | Microsoft US Building Footprints, Hawaii, clipped | ODbL |
| `osm_lahaina.json` | OpenStreetMap named roads and landmarks (for geocoding FSRI reports) | ODbL |
| `weather_PHOG.csv` | Kahului Airport ASOS, 5-minute records Aug 7–20 (Iowa Environmental Mesonet) | Public domain |
| `goes18_scans.csv`, `goes18_fire_pixels.csv` | GOES-18 ABI fire product (FDCC), 06:00 Aug 8 – 14:00 Aug 9 HST, Lahaina vicinity | Public domain |
| `firms_west_maui_aug2023.csv` | NASA FIRMS VIIRS (S-NPP, NOAA-20) and MODIS detections, West Maui, Aug 1–20 | NASA open data |

## derived/: built by `demo-data build`

| File | Contents |
|---|---|
| `burned.tif`, `perimeter.tif` | Burn scar from Sentinel-2 dNBR inside the perimeter; rasterized official perimeter |
| `fuel.tif` | Fuel class per 10 m cell |
| `arrival.tif` | Minutes after the 14:52 rekindle when the synthetic fire reaches each cell |
| `speed_multiplier.tif` | Local spread-speed adjustments from calibration |
| `buildings_2m.tif` | Building footprints at 2 m (where flames and embers render) |
| `structures.geojson` | Pre-fire buildings with modelled ignition time and fate |
| `spot_fires.json`, `calibration.json` | Calibration against the FSRI sightings |
| `coregistration.json` | Measured per-layer imagery shifts, corrected at read time |

## verify/: written by `demo-data verify` and `demo-data timeline`

- `report.json`: alignment, camera round-trip, perimeter and fire-model checks.
- `align_*.png`: Sentinel-2 (red) over each layer (cyan); aligned edges appear white.
- `timeline_*.png`: one view across the fire (RGB | thermal | labels).
