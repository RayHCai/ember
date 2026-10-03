"""Non-imagery source downloads: perimeter, FSRI timeline, weather, hotspots, Sentinel-2,
land cover and building footprints. Outputs land in data/raw/."""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np

from ..config import AOI, RAW_DIR, USER_AGENT, UTM_EPSG, WEATHER_STATION
from ..model.grid import GRID

log = logging.getLogger(__name__)

# Wider box used for satellite hotspots so detections just outside the AOI are kept.
MAUI_WEST_BOX = dict(lat_min=20.70, lat_max=21.05, lon_min=-156.75, lon_max=-156.55)


def _client(timeout: float = 120.0) -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True)


def _skip(path: Path, force: bool) -> bool:
    if path.exists() and not force:
        log.info("exists, skipping: %s", path)
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    return False


def perimeter(force: bool = False) -> None:
    out = RAW_DIR / "wfigs_lahaina_perimeter.geojson"
    if _skip(out, force):
        return
    url = (
        "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/"
        "FeatureServer/0/query"
    )
    params = {
        "where": "attr_UniqueFireIdentifier='2023-HIMAUX-000775'",
        "outFields": "poly_IncidentName,poly_GISAcres,attr_UniqueFireIdentifier,poly_MapMethod,poly_DateCurrent",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    with _client() as c:
        r = c.get(url, params=params)
        r.raise_for_status()
    data = r.json()
    if not data.get("features"):
        raise RuntimeError("WFIGS returned no Lahaina perimeter")
    out.write_text(json.dumps(data))
    log.info("perimeter: %s", data["features"][0]["properties"])


def fsri(force: bool = False) -> None:
    """FSRI Lahaina Fire Comprehensive Timeline, Phase 1 dataset (CC BY-SA 4.0)."""
    out = RAW_DIR / "fsri_timeline.csv"
    if _skip(out, force):
        return
    url = "https://docs.google.com/spreadsheets/d/1hHpttLG9YRkwYnW3DWYZZP-kRoUB1vvJSmeqOuAkhxk/export"
    with _client() as c:
        r = c.get(url, params={"format": "csv", "gid": "30919330"})
        r.raise_for_status()
    out.write_bytes(r.content)
    log.info("fsri: %d bytes", len(r.content))


def weather(force: bool = False) -> None:
    """5-minute ASOS observations from Iowa Environmental Mesonet (times in UTC)."""
    out = RAW_DIR / f"weather_{WEATHER_STATION['id']}.csv"
    if _skip(out, force):
        return
    params = [("station", WEATHER_STATION["id"])]
    params += [("data", v) for v in ("tmpf", "dwpf", "relh", "drct", "sknt", "gust", "vsby", "wxcodes")]
    params += [
        ("year1", "2023"), ("month1", "8"), ("day1", "7"),
        ("year2", "2023"), ("month2", "8"), ("day2", "20"),
        ("tz", "Etc/UTC"), ("format", "onlycomma"), ("latlon", "no"), ("missing", "M"),
    ]
    with _client() as c:
        r = c.get("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py", params=params)
        r.raise_for_status()
    out.write_text(r.text)
    log.info("weather: %d rows", r.text.count("\n") - 1)


def firms(force: bool = False) -> None:
    """VIIRS (S-NPP, NOAA-20) and MODIS active-fire points, filtered to West Maui, Aug 1-20 2023."""
    out = RAW_DIR / "firms_west_maui_aug2023.csv"
    if _skip(out, force):
        return
    products = {
        "VIIRS_SNPP": "viirs-snpp/2023/viirs-snpp_2023_United_States.csv",
        "VIIRS_NOAA20": "viirs-jpss1/2023/viirs-jpss1_2023_United_States.csv",
        "MODIS": "modis/2023/modis_2023_United_States.csv",
    }
    b = MAUI_WEST_BOX
    rows: list[dict] = []
    with _client(timeout=600) as c:
        for product, path in products.items():
            url = f"https://firms.modaps.eosdis.nasa.gov/data/country/{path}"
            with c.stream("GET", url) as r:
                r.raise_for_status()
                reader = csv.DictReader(r.iter_lines())
                for row in reader:
                    if not ("2023-08-01" <= row["acq_date"] <= "2023-08-20"):
                        continue
                    lat, lon = float(row["latitude"]), float(row["longitude"])
                    if b["lat_min"] <= lat <= b["lat_max"] and b["lon_min"] <= lon <= b["lon_max"]:
                        rows.append({"product": product, **row})
            log.info("firms %s: %d rows so far", product, len(rows))
    fields = ["product", "latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument",
              "confidence", "frp", "daynight", "scan", "track"]
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def sentinel2(force: bool = False) -> None:
    """Sentinel-2 L2A surface reflectance on the analysis grid (Aug 3, Aug 8, Aug 13 2023)."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    out_dir = RAW_DIR / "sentinel2"
    bands = ["blue", "green", "red", "nir", "nir08", "swir16", "swir22", "scl"]
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": AOI.as_list(),
        "datetime": "2023-08-02T00:00:00Z/2023-08-14T23:59:59Z",
        "query": {"grid:code": {"eq": "MGRS-4QGJ"}},
        "limit": 20,
    }
    with _client() as c:
        r = c.post("https://earth-search.aws.element84.com/v1/search", json=body)
        r.raise_for_status()
    items = r.json()["features"]
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_HTTP_MAX_RETRY="4")
    for item in items:
        date = item["properties"]["datetime"][:10].replace("-", "")
        out = out_dir / f"S2_{date}.tif"
        if _skip(out, force):
            continue
        stack = np.zeros((len(bands),) + GRID.shape, dtype=np.float32)
        with rasterio.Env(**env):
            for i, band in enumerate(bands):
                asset = item["assets"][band]
                with rasterio.open(asset["href"]) as src:
                    resampling = Resampling.nearest if band == "scl" else Resampling.bilinear
                    reproject(
                        source=rasterio.band(src, 1),
                        destination=stack[i],
                        dst_transform=GRID.transform,
                        dst_crs=f"EPSG:{UTM_EPSG}",
                        resampling=resampling,
                    )
                if band != "scl":
                    rb = (asset.get("raster:bands") or [{}])[0]
                    stack[i] = stack[i] * rb.get("scale", 1e-4) + rb.get("offset", -0.1)
        profile = GRID.profile("float32", len(bands), None)
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(stack)
            for i, band in enumerate(bands, 1):
                dst.set_band_description(i, band)
            dst.update_tags(item_id=item["id"], datetime=item["properties"]["datetime"],
                            cloud_cover=str(item["properties"].get("eo:cloud_cover")))
        (out_dir / f"S2_{date}.stac.json").write_text(json.dumps(item))
        log.info("sentinel2 %s -> %s", item["id"], out)


def worldcover(force: bool = False) -> None:
    """ESA WorldCover 2021 v200 land cover (CC BY 4.0), resampled onto the analysis grid."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    out = RAW_DIR / "worldcover_2021.tif"
    if _skip(out, force):
        return
    href = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N18W159_Map.tif"
    dst = np.zeros(GRID.shape, dtype=np.uint8)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(href) as src:
            reproject(
                source=rasterio.band(src, 1),
                destination=dst,
                dst_transform=GRID.transform,
                dst_crs=f"EPSG:{UTM_EPSG}",
                resampling=Resampling.nearest,
            )
    with rasterio.open(out, "w", **GRID.profile("uint8", 1, 0)) as f:
        f.write(dst[None])
    log.info("worldcover classes: %s", dict(zip(*np.unique(dst, return_counts=True))))


def buildings(force: bool = False) -> None:
    """Pre-fire building footprints: OpenStreetMap as of 2023-08-07 (Overpass "attic" query; many
    destroyed buildings were deleted from OSM later) plus Microsoft US Building Footprints. Both ODbL."""
    out_osm = RAW_DIR / "buildings_osm_20230807.geojson"
    if not _skip(out_osm, force):
        bb = f"{AOI.south},{AOI.west},{AOI.north},{AOI.east}"
        query = f'[out:json][timeout:180][date:"2023-08-07T00:00:00Z"];way["building"]({bb});out geom;'
        with _client(timeout=300) as c:
            r = c.post("https://overpass-api.de/api/interpreter", data={"data": query})
            r.raise_for_status()
        feats = []
        for e in r.json()["elements"]:
            ring = [[p["lon"], p["lat"]] for p in e.get("geometry", [])]
            if len(ring) >= 4 and ring[0] == ring[-1]:
                props = {"osm_id": e["id"], "building": e["tags"].get("building"), "name": e["tags"].get("name")}
                feats.append({"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}})
        out_osm.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
        log.info("buildings (OSM 2023-08-07): %d", len(feats))

    out = RAW_DIR / "buildings_microsoft.geojson"
    if _skip(out, force):
        return
    url = "https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Hawaii.geojson.zip"
    with _client(timeout=600) as c:
        r = c.get(url)
        r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        name = next(n for n in z.namelist() if n.endswith(".geojson"))
        data = json.loads(z.read(name))
    kept = []
    for f in data["features"]:
        ring = f["geometry"]["coordinates"][0]
        lon = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        if AOI.contains(lon, lat):
            kept.append({"type": "Feature", "properties": {"id": len(kept)}, "geometry": f["geometry"]})
    out.write_text(json.dumps({"type": "FeatureCollection", "features": kept}))
    log.info("buildings: %d in AOI (of %d in Hawaii)", len(kept), len(data["features"]))


# --- GOES-18 fire detections -----------------------------------------------------------------

GOES_BOX = dict(lat_min=20.80, lat_max=20.96, lon_min=-156.74, lon_max=-156.60)
FIRE_CODES = {10, 11, 12, 13, 14, 15, 30, 31, 32, 33, 34, 35}


def _goes_latlon(h) -> tuple[np.ndarray, np.ndarray]:
    def scaled(name):
        v = h[name]
        return v[:] * v.attrs["scale_factor"][0] + v.attrs["add_offset"][0]

    x, y = scaled("x"), scaled("y")
    p = h["goes_imager_projection"].attrs
    r_eq, r_pol = p["semi_major_axis"][0], p["semi_minor_axis"][0]
    H = p["perspective_point_height"][0] + r_eq
    lon0 = np.deg2rad(p["longitude_of_projection_origin"][0])
    X, Y = np.meshgrid(x, y)
    a = np.sin(X) ** 2 + np.cos(X) ** 2 * (np.cos(Y) ** 2 + (r_eq**2 / r_pol**2) * np.sin(Y) ** 2)
    b = -2 * H * np.cos(X) * np.cos(Y)
    c = H**2 - r_eq**2
    with np.errstate(invalid="ignore"):
        rs = (-b - np.sqrt(b**2 - 4 * a * c)) / (2 * a)
    sx, sy, sz = rs * np.cos(X) * np.cos(Y), -rs * np.sin(X), rs * np.cos(X) * np.sin(Y)
    lat = np.rad2deg(np.arctan((r_eq**2 / r_pol**2) * sz / np.sqrt((H - sx) ** 2 + sy**2)))
    lon = np.rad2deg(lon0 - np.arctan(sy / (H - sx)))
    return lat, lon


def _scaled_var(h, name, idx):
    v = h[name]
    raw = v[:][idx].astype(np.float64)
    fill = v.attrs.get("_FillValue")
    out = raw * v.attrs.get("scale_factor", [1.0])[0] + v.attrs.get("add_offset", [0.0])[0]
    if fill is not None:
        out[raw == fill[0]] = np.nan
    return out


def goes(force: bool = False) -> None:
    """GOES-18 ABI fire/hot spot characterization (PACUS sector, 5-minute), Lahaina vicinity."""
    import h5py

    scans_out = RAW_DIR / "goes18_scans.csv"
    pixels_out = RAW_DIR / "goes18_fire_pixels.csv"
    if _skip(scans_out, force):
        return
    start = datetime(2023, 8, 8, 16, tzinfo=timezone.utc)  # 06:00 HST Aug 8
    hours = [start + timedelta(hours=i) for i in range(34)]  # to 14:00 HST Aug 9
    keys: list[str] = []
    with _client() as c:
        for t in hours:
            prefix = f"ABI-L2-FDCC/{t:%Y}/{t.timetuple().tm_yday:03d}/{t:%H}/"
            r = c.get("https://noaa-goes18.s3.amazonaws.com/", params={"list-type": "2", "prefix": prefix})
            r.raise_for_status()
            keys += re.findall(r"<Key>([^<]+)</Key>", r.text)
    log.info("goes: %d files", len(keys))
    cache: dict = {}

    def fetch(key: str) -> bytes:
        for attempt in range(5):
            try:
                with _client() as c:
                    r = c.get(f"https://noaa-goes18.s3.amazonaws.com/{key}")
                    r.raise_for_status()
                    return r.content
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                log.warning("goes: retry %d for %s (%s)", attempt + 1, key, exc)
                time.sleep(2.0 * (attempt + 1))
        raise RuntimeError(f"goes: could not download {key}")

    scans, pixels = [], []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for key, blob in zip(keys, pool.map(fetch, keys)):
            m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", key)
            year, doy, hh, mm, ss = map(int, m.groups())
            scan = datetime(year, 1, 1, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=doy - 1)
            with h5py.File(io.BytesIO(blob), "r") as h:
                gkey = (h["x"].shape[0], h["y"].shape[0], int(h["x"][0]), int(h["y"][0]))
                if gkey not in cache:
                    lat, lon = _goes_latlon(h)
                    b = GOES_BOX
                    sel = (lat >= b["lat_min"]) & (lat <= b["lat_max"]) & (lon >= b["lon_min"]) & (lon <= b["lon_max"])
                    rr, cc = np.nonzero(sel)
                    r0, r1, c0, c1 = rr.min(), rr.max() + 1, cc.min(), cc.max() + 1
                    cache[gkey] = ((slice(r0, r1), slice(c0, c1)), lat[r0:r1, c0:c1], lon[r0:r1, c0:c1])
                idx, lat, lon = cache[gkey]
                mask = h["Mask"][:][idx]
                power = _scaled_var(h, "Power", idx)
                temp = _scaled_var(h, "Temp", idx)
                area = _scaled_var(h, "Area", idx)
            fire = np.isin(mask, list(FIRE_CODES))
            total = float(np.nansum(np.where(fire, power, 0.0)))
            scans.append({"scan_start_utc": scan.isoformat(), "fire_pixels": int(fire.sum()), "frp_mw": round(total, 1)})
            for r_, c_ in zip(*np.nonzero(fire)):
                pixels.append({
                    "scan_start_utc": scan.isoformat(), "lat": round(float(lat[r_, c_]), 5),
                    "lon": round(float(lon[r_, c_]), 5), "mask": int(mask[r_, c_]),
                    "frp_mw": None if np.isnan(power[r_, c_]) else round(float(power[r_, c_]), 1),
                    "temp_k": None if np.isnan(temp[r_, c_]) else round(float(temp[r_, c_]), 1),
                    "area_km2": None if np.isnan(area[r_, c_]) else round(float(area[r_, c_]), 4),
                })
    scans.sort(key=lambda s: s["scan_start_utc"])
    pixels.sort(key=lambda p: p["scan_start_utc"])
    for path, rows in ((scans_out, scans), (pixels_out, pixels)):
        with path.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    log.info("goes: %d scans, %d fire pixels", len(scans), len(pixels))


def osm(force: bool = False) -> None:
    """OpenStreetMap named roads and landmarks in the AOI (ODbL), used to geocode FSRI reports."""
    out = RAW_DIR / "osm_lahaina.json"
    if _skip(out, force):
        return
    bb = f"{AOI.south},{AOI.west},{AOI.north},{AOI.east}"
    keys = ["amenity", "tourism", "historic", "leisure", "shop", "building", "landuse", "man_made",
            "natural", "place", "office", "power"]
    parts = [f'way["highway"]["name"]({bb});'] + [f'nwr["name"]["{k}"]({bb});' for k in keys]
    query = f"[out:json][timeout:120];({''.join(parts)});out geom;"
    with _client(timeout=300) as c:
        r = c.post("https://overpass-api.de/api/interpreter", data={"data": query})
        r.raise_for_status()
    out.write_bytes(r.content)
    log.info("osm: %d elements", len(r.json()["elements"]))


STEPS = {
    "perimeter": perimeter,
    "osm": osm,
    "fsri": fsri,
    "weather": weather,
    "firms": firms,
    "sentinel2": sentinel2,
    "worldcover": worldcover,
    "buildings": buildings,
    "goes": goes,
}
