"""Georeferencing and model checks. `demo-data verify` runs them all and writes
data/verify/report.json plus alignment images.

1. Imagery alignment: every cached tile layer is correlated against Sentinel-2, which is
   independently georeferenced (ESA orthorectified, native UTM). A tile-scheme or axis-order
   mistake shows up as a huge or meaningless offset; a correct layer sits within a few metres.
2. Camera round trip: random drone poses; pixel -> ground lat/lon -> back to pixel.
3. Frame centre: a nadir frame's centre pixel maps back to the drone's own lat/lon.
4. Perimeter area: rasterised official perimeter vs the published acreage.
5. Fire model: calibration error against the FSRI sightings, and timing against GOES-18.
"""

from __future__ import annotations

import csv
import json
import logging
import math
from datetime import datetime
from typing import Any

import cv2
import numpy as np
import rasterio
from PIL import Image

from .config import DERIVED_DIR, HST, LAYERS, RAW_DIR, REKINDLE, VERIFY_DIR, hst
from .geo import LocalFrame, from_utm, to_utm
from .model.grid import GRID
from .render.camera import Camera, Pose, basis, cast
from .render.sampling import Bilinear
from .tiles import sampler

log = logging.getLogger(__name__)

# Lahaina town: coast, harbour, Front St grid and the highway; plenty of stable edges.
CHECK_LONLAT = (-156.690, 20.865, -156.665, 20.895)
CHECK_RES = 2.5
MAX_OFFSET_M = 15.0


def _check_grid() -> tuple[np.ndarray, np.ndarray]:
    w, s, e, n = CHECK_LONLAT
    xs, ys = to_utm([w, e, e, w], [s, s, n, n])
    x0, x1 = math.floor(min(xs)), math.ceil(max(xs))
    y0, y1 = math.floor(min(ys)), math.ceil(max(ys))
    cols = np.arange(x0, x1, CHECK_RES) + CHECK_RES / 2
    rows = np.arange(y1, y0, -CHECK_RES) - CHECK_RES / 2
    E, N = np.meshgrid(cols, rows)
    return E, N


def _edges(img: np.ndarray, sigma_px: float) -> np.ndarray:
    img = cv2.GaussianBlur(img.astype(np.float32), (0, 0), sigma_px)
    gx = cv2.Sobel(img, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(img, cv2.CV_32F, 0, 1)
    mag = np.hypot(gx, gy)
    return (mag - mag.mean()) / (mag.std() + 1e-6)


def _s2_band(date: str, band: str, E: np.ndarray, N: np.ndarray) -> np.ndarray:
    with rasterio.open(RAW_DIR / "sentinel2" / f"S2_{date}.tif") as src:
        names = list(src.descriptions)
        arr = src.read(names.index(band) + 1).astype(np.float32)
    r, c = GRID.utm_to_rc(E.ravel(), N.ravel())
    return Bilinear(r, c, GRID.shape)(arr).reshape(E.shape)


COREG_REFERENCE = "maxar_20230812"  # best match to Sentinel-2 (0.3 m)
COREG_RES = 1.0


def _layer_image(
    layer_id: str, E: np.ndarray, N: np.ndarray, res: float, corrected: bool = True
) -> tuple[np.ndarray, np.ndarray]:
    lon, lat = from_utm(E.ravel(), N.ravel())
    s = sampler(layer_id)
    if not corrected:
        saved, s.displacement = s.displacement, (0.0, 0.0)
    try:
        rgb, ok = s.sample(np.asarray(lon), np.asarray(lat), res, max_tiles=900)
    finally:
        if not corrected:
            s.displacement = saved
    return rgb.mean(axis=1).reshape(E.shape), ok.reshape(E.shape)


def _phase_offset(
    ref: np.ndarray, img: np.ndarray, valid: np.ndarray, res: float, sigma_px: float
) -> tuple[float, float, float]:
    a, b = _edges(ref, sigma_px), _edges(img, sigma_px)
    a[~valid] = 0
    b[~valid] = 0
    win = cv2.createHanningWindow(a.shape[::-1], cv2.CV_32F)
    (dx, dy), response = cv2.phaseCorrelate(a, b, win)
    return dx * res, -dy * res, float(response)


def coregister() -> dict[str, Any]:
    """Measure each layer's displacement relative to the reference layer at 1 m and save it.

    Displacement (east, north) means a feature at true position P appears in the layer at
    P + displacement; the sampler reads at P + displacement to undo it.
    """
    E, N = _check_grid()
    cols = np.arange(E[0, 0] - CHECK_RES / 2 + COREG_RES / 2, E[0, -1] + CHECK_RES / 2, COREG_RES)
    rows = np.arange(N[0, 0] + CHECK_RES / 2 - COREG_RES / 2, N[-1, 0] - CHECK_RES / 2, -COREG_RES)
    E1, N1 = np.meshgrid(cols, rows)
    ref, ref_ok = _layer_image(COREG_REFERENCE, E1, N1, COREG_RES, corrected=False)
    out: dict[str, Any] = {"reference": COREG_REFERENCE, "resolution_m": COREG_RES, "layers": {}}
    for layer_id in LAYERS:
        if layer_id == COREG_REFERENCE:
            out["layers"][layer_id] = {
                "displacement_east_m": 0.0,
                "displacement_north_m": 0.0,
                "response": 1.0,
            }
            continue
        img, ok = _layer_image(layer_id, E1, N1, COREG_RES, corrected=False)
        de, dn, resp = _phase_offset(ref, img, ref_ok & ok, COREG_RES, 2.0)
        out["layers"][layer_id] = {
            "displacement_east_m": round(de, 2),
            "displacement_north_m": round(dn, 2),
            "response": round(resp, 3),
        }
        log.info(
            "coregistration %s vs %s: east %.2f m, north %.2f m (response %.3f)",
            layer_id,
            COREG_REFERENCE,
            de,
            dn,
            resp,
        )
    (DERIVED_DIR / "coregistration.json").write_text(json.dumps(out, indent=2))
    from .tiles import reset_samplers

    reset_samplers()
    return out


def imagery_alignment() -> list[dict[str, Any]]:
    E, N = _check_grid()
    lon, lat = from_utm(E.ravel(), N.ravel())
    lon, lat = np.asarray(lon), np.asarray(lat)
    pairs = {
        "pre_2020": "20230803",
        "maxar_20230809": "20230813",
        "maxar_20230812": "20230813",
        "waldo_20230814": "20230813",
    }
    out: list[dict[str, Any]] = []
    VERIFY_DIR.mkdir(parents=True, exist_ok=True)
    for layer_id, s2date in pairs.items():
        rgb, ok = sampler(layer_id).sample(lon, lat, CHECK_RES, max_tiles=400)
        img = rgb.mean(axis=1).reshape(E.shape)
        valid = ok.reshape(E.shape)
        s2 = _s2_band(s2date, "red", E, N)
        # Correlate edge maps at Sentinel-2's scale (10 m pixels -> blur ~4 px at 2.5 m).
        a, b = _edges(s2, 4.0), _edges(img, 4.0)
        a[~valid] = 0
        b[~valid] = 0
        win = cv2.createHanningWindow(a.shape[::-1], cv2.CV_32F)
        (dx, dy), response = cv2.phaseCorrelate(a, b, win)
        east_m, north_m = dx * CHECK_RES, -dy * CHECK_RES
        offset = math.hypot(east_m, north_m)
        ok_flag = bool(offset <= MAX_OFFSET_M and valid.mean() > 0.3)
        out.append(
            {
                "layer": layer_id,
                "reference": f"Sentinel-2 L2A {s2date} red band",
                "offset_east_m": round(east_m, 2),
                "offset_north_m": round(north_m, 2),
                "offset_m": round(offset, 2),
                "response": round(float(response), 3),
                "coverage": round(float(valid.mean()), 3),
                "pass": ok_flag,
            }
        )

        # Visual: S2 in red, layer in cyan; aligned edges overlap as white.
        def norm(x: np.ndarray) -> np.ndarray:
            x = x[::2, ::2]
            scaled = (x - np.percentile(x, 2)) / (np.percentile(x, 98) - np.percentile(x, 2) + 1e-6)
            return np.asarray(np.clip(scaled, 0, 1))

        overlay = np.stack([norm(s2), norm(img), norm(img)], -1)
        Image.fromarray((overlay * 255).astype(np.uint8)).save(VERIFY_DIR / f"align_{layer_id}.png")
    return out


def _project(
    pose: Pose, cam: Camera, lon: np.ndarray, lat: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of cast(): ground lat/lon -> pixel (u, v)."""
    frame = LocalFrame(pose.lon, pose.lat)
    e, n = frame.from_lonlat(lon, lat)
    v = np.stack([np.asarray(e), np.asarray(n), np.full(np.shape(e), -pose.alt_m)], -1)
    fwd, right, down = basis(pose)
    zc = v @ fwd
    u = cam.width / 2 + cam.fx * (v @ right) / zc
    w = cam.height / 2 + cam.fx * (v @ down) / zc
    return u, w


def camera_round_trip(samples: int = 25, seed: int = 7) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    worst_px, worst_center_m = 0.0, 0.0
    cam = Camera()
    for _ in range(samples):
        pose = Pose(
            lat=float(rng.uniform(20.86, 20.90)),
            lon=float(rng.uniform(-156.685, -156.66)),
            alt_m=float(rng.uniform(30, 400)),
            heading_deg=float(rng.uniform(0, 360)),
            pitch_deg=float(rng.uniform(-90, -20)),
        )
        hits = cast(pose, cam)
        g = hits.ground
        V, U = np.nonzero(g)
        pick = rng.choice(len(U), size=min(400, len(U)), replace=False)
        u_back, v_back = _project(pose, cam, hits.lon[g][pick], hits.lat[g][pick])
        err = np.hypot(u_back - (U[pick] + 0.5), v_back - (V[pick] + 0.5))
        worst_px = max(worst_px, float(err.max()))
        nadir = Pose(pose.lat, pose.lon, pose.alt_m, pose.heading_deg, -90.0)
        u0, v0 = _project(nadir, Camera(641, 481), np.array([pose.lon]), np.array([pose.lat]))
        worst_center_m = max(worst_center_m, float(math.hypot(u0[0] - 320.5, v0[0] - 240.5)))
    return {
        "samples": samples,
        "max_pixel_error": round(worst_px, 5),
        "pass": worst_px < 0.05,
        "nadir_drone_position_pixel_error": round(worst_center_m, 5),
    }


def perimeter_area() -> dict[str, Any]:
    feats = json.loads((RAW_DIR / "wfigs_lahaina_perimeter.geojson").read_text())["features"]
    published = float(feats[0]["properties"]["poly_GISAcres"])
    with rasterio.open(DERIVED_DIR / "perimeter.tif") as src:
        cells = int(src.read(1).sum())
    raster = cells * GRID.res**2 / 4046.86
    return {
        "published_acres": round(published, 1),
        "rasterised_acres": round(raster, 1),
        "difference_pct": round(100 * (raster - published) / published, 2),
        "pass": abs(raster - published) / published < 0.02,
    }


def fire_model() -> dict[str, Any]:
    cal = json.loads((DERIVED_DIR / "calibration.json").read_text())["summary"]
    from .model.state import scenario

    sc = scenario()
    scans = []
    with (RAW_DIR / "goes18_scans.csv").open() as f:
        for r in csv.DictReader(f):
            scans.append((datetime.fromisoformat(r["scan_start_utc"]), float(r["frp_mw"])))
    window = [(t, frp) for t, frp in scans if hst(2023, 8, 8, 14, 0) <= t <= hst(2023, 8, 9, 8, 0)]
    model_series = []
    for t, _ in window:
        fields = sc.fields(t)
        model_series.append(float(fields.intensity.sum() + 0.25 * fields.smoulder.sum()))
    goes = np.array([frp for _, frp in window])
    model = np.array(model_series)
    corr = float(np.corrcoef(goes, model)[0, 1]) if goes.std() > 0 else float("nan")
    first_goes = next((t for t, frp in window if frp > 0 and t >= REKINDLE), None)
    peak_goes = window[int(np.argmax(goes))][0]
    peak_model = window[int(np.argmax(model))][0]
    return {
        "calibration": cal,
        "goes18_vs_model_correlation": round(corr, 3),
        "goes18_first_detection": first_goes.astimezone(HST).isoformat() if first_goes else None,
        "goes18_peak": peak_goes.astimezone(HST).isoformat(),
        "model_peak": peak_model.astimezone(HST).isoformat(),
        "note": "GOES-18 fire radiative power (2 km pixels, every 5 min) vs the model's total "
        "fire intensity.",
    }


def pairwise_residuals() -> list[dict[str, Any]]:
    """After correction, every layer against the reference at 1 m (should be ~0)."""
    E, N = _check_grid()
    cols = np.arange(E[0, 0], E[0, -1], COREG_RES)
    rows = np.arange(N[0, 0], N[-1, 0], -COREG_RES)
    E1, N1 = np.meshgrid(cols, rows)
    ref, ref_ok = _layer_image(COREG_REFERENCE, E1, N1, COREG_RES)
    out: list[dict[str, Any]] = []
    for layer_id in LAYERS:
        if layer_id == COREG_REFERENCE:
            continue
        img, ok = _layer_image(layer_id, E1, N1, COREG_RES)
        de, dn, resp = _phase_offset(ref, img, ref_ok & ok, COREG_RES, 2.0)
        res = math.hypot(de, dn)
        out.append(
            {
                "layer": layer_id,
                "reference": COREG_REFERENCE,
                "residual_east_m": round(de, 2),
                "residual_north_m": round(dn, 2),
                "residual_m": round(res, 2),
                "response": round(resp, 3),
                "pass": res <= 2.0,
            }
        )
    return out


def run_all() -> bool:
    report: dict[str, Any] = {
        "coregistration_applied": json.loads((DERIVED_DIR / "coregistration.json").read_text())
        if (DERIVED_DIR / "coregistration.json").exists()
        else None,
        "layer_to_layer_after_correction": pairwise_residuals(),
        "imagery_alignment": imagery_alignment(),
        "camera_round_trip": camera_round_trip(),
        "perimeter_area": perimeter_area(),
        "fire_model": fire_model(),
    }
    ok = (
        all(r["pass"] for r in report["imagery_alignment"])
        and all(r["pass"] for r in report["layer_to_layer_after_correction"])
        and report["camera_round_trip"]["pass"]
        and report["perimeter_area"]["pass"]
    )
    report["pass"] = ok
    VERIFY_DIR.mkdir(parents=True, exist_ok=True)
    (VERIFY_DIR / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return ok
