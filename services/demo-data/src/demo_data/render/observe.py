"""One drone observation: camera frames plus the context a drone needs to classify, plan and
set goals, all georeferenced to the pose it was rendered for."""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import Polygon

from ..config import AOI, HST, SCENARIO_END, SCENARIO_START
from ..context import satellite_at, structures, weather_at
from ..geo import LocationError, validate_position
from ..model.state import CLASS_NAMES, NO_DATA, scenario
from .camera import Camera, Pose, cast, footprint
from .compositor import SKY_K, GroundPoints, clamp_gsd, epoch_for, fire_smokiness, lighting, render_ground, sky_rgb

HOTSPOT_K = 450.0
LABEL_PALETTE = {
    0: (46, 125, 50), 1: (251, 192, 45), 2: (229, 57, 53), 3: (142, 36, 170),
    4: (66, 66, 66), 5: (30, 136, 229), 255: (0, 0, 0),
}


class TimeError(ValueError):
    pass


def validate_time(t: datetime) -> datetime:
    if t.tzinfo is None:
        raise TimeError("scenario time must include a UTC offset, e.g. 2023-08-08T16:30:00-10:00")
    if not (SCENARIO_START <= t <= SCENARIO_END):
        raise TimeError(f"scenario time {t.isoformat()} is outside {SCENARIO_START.isoformat()} .. {SCENARIO_END.isoformat()}")
    return t


@dataclass
class FrameImages:
    rgb: np.ndarray  # (H, W, 3) uint8
    thermal_k: np.ndarray  # (h, w) float32 kelvin
    labels: np.ndarray | None  # (H, W) uint8, ground truth

    def rgb_image(self) -> Image.Image:
        return Image.fromarray(self.rgb, "RGB")

    def rgb_jpeg(self, quality: int = 85) -> bytes:
        buf = io.BytesIO()
        self.rgb_image().save(buf, "JPEG", quality=quality)
        return buf.getvalue()

    def thermal_png16(self) -> bytes:
        """16-bit greyscale PNG in deci-kelvin: kelvin = pixel / 10."""
        dk = np.clip(np.round(self.thermal_k * 10), 0, 65535).astype(np.uint16)
        buf = io.BytesIO()
        Image.fromarray(dk).save(buf, "PNG")
        return buf.getvalue()

    def thermal_preview(self) -> Image.Image:
        k = self.thermal_k
        x = np.clip((np.log(np.maximum(k, 250.0)) - math.log(285.0)) / (math.log(1200.0) - math.log(285.0)), 0, 1)
        r = np.clip(x * 3.0, 0, 1)
        g = np.clip(x * 3.0 - 1.0, 0, 1)
        b = np.clip(x * 3.0 - 2.0, 0, 1) * 0.8 + np.clip(0.35 - x, 0, 0.35)
        return Image.fromarray((np.stack([r, g, b], -1) * 255).astype(np.uint8), "RGB")

    def labels_png(self) -> bytes:
        img = Image.fromarray(self.labels, "P")
        pal = [0] * 768
        for k, (r, g, b) in LABEL_PALETTE.items():
            pal[k * 3 : k * 3 + 3] = [r, g, b]
        img.putpalette(pal)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()

    def labels_preview(self) -> Image.Image:
        return Image.open(io.BytesIO(self.labels_png())).convert("RGB")


@dataclass
class Observation:
    pose: Pose
    camera: Camera
    thermal_camera: Camera
    t: datetime
    epoch: dict
    footprint: list[tuple[float, float]]
    center_ground: tuple[float, float] | None
    gsd_m: float
    coverage: float
    images: FrameImages
    hotspots: list[dict]
    environment: dict
    satellite: dict
    structures: dict
    truth: dict | None = None
    sources: dict = field(default_factory=dict)

    def metadata(self) -> dict:
        lon_c, lat_c = self.center_ground if self.center_ground else (None, None)
        return {
            "scenario_time": self.t.astimezone(HST).isoformat(),
            "pose": {"lat": self.pose.lat, "lon": self.pose.lon, "alt_m": self.pose.alt_m,
                     "heading_deg": self.pose.heading_deg, "pitch_deg": self.pose.pitch_deg},
            "camera": {"width": self.camera.width, "height": self.camera.height, "hfov_deg": self.camera.hfov_deg,
                       "vfov_deg": round(self.camera.vfov_deg, 3), "gsd_m": round(self.gsd_m, 3)},
            "thermal_camera": {"width": self.thermal_camera.width, "height": self.thermal_camera.height,
                               "hfov_deg": self.thermal_camera.hfov_deg, "encoding": "uint16 PNG, kelvin = value / 10"},
            "georef": {
                "crs": "EPSG:4326",
                "center_ground": None if lat_c is None else {"lat": round(lat_c, 7), "lon": round(lon_c, 7)},
                "footprint": {"type": "Polygon",
                              "coordinates": [[[round(x, 7), round(y, 7)] for x, y in self.footprint + self.footprint[:1]]]},
                "coverage_fraction": round(self.coverage, 4),
                "model": "pinhole camera, flat ground at the drone's ground level, exact local azimuthal "
                         "equidistant projection to lat/lon",
            },
            "imagery": {**self.epoch, "layers_used": self.sources},
            "hotspots": self.hotspots,
            "environment": self.environment,
            "satellite": self.satellite,
            "structures": self.structures,
            **({"truth": self.truth} if self.truth is not None else {}),
        }

    def to_message(self, include: set[str]) -> dict:
        msg = self.metadata()
        imgs = {}
        if "rgb" in include:
            imgs["rgb"] = {"format": "jpeg", "encoding": "base64", "data": base64.b64encode(self.images.rgb_jpeg()).decode()}
        if "thermal" in include:
            imgs["thermal"] = {"format": "png16_decikelvin", "encoding": "base64",
                               "data": base64.b64encode(self.images.thermal_png16()).decode()}
        if "labels" in include and self.images.labels is not None:
            imgs["labels"] = {"format": "png_palette", "encoding": "base64", "classes": CLASS_NAMES,
                              "data": base64.b64encode(self.images.labels_png()).decode()}
        msg["images"] = imgs
        return msg


def _thermal_hotspots(hits, temp: np.ndarray, gsd: float) -> list[dict]:
    """Connected hot regions in the thermal frame, located on the ground."""
    hot = (temp > HOTSPOT_K) & hits.ground
    if not hot.any():
        return []
    lab, _ = ndimage.label(hot)
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        if sl is None:
            continue
        m = lab[sl] == i
        tt = temp[sl][m]
        w = tt - 300.0
        lon = float(np.sum(hits.lon[sl][m] * w) / np.sum(w))
        lat = float(np.sum(hits.lat[sl][m] * w) / np.sum(w))
        out.append({"lat": round(lat, 7), "lon": round(lon, 7), "max_temp_k": round(float(tt.max()), 1),
                    "pixels": int(m.sum()), "area_m2": round(float(m.sum()) * gsd * gsd, 1),
                    "bbox_px": [sl[1].start, sl[0].start, sl[1].stop, sl[0].stop]})
    out.sort(key=lambda h: -h["max_temp_k"])
    return out[:50]


def _points(hits) -> GroundPoints:
    g = hits.ground
    return GroundPoints(hits.lon[g], hits.lat[g], hits.utm_e[g], hits.utm_n[g])


def observe(pose: Pose, t: datetime, width: int = 640, height: int = 480, hfov_deg: float = 84.0,
            thermal_width: int = 320, include_truth: bool = False) -> Observation:
    pose = pose.validated()
    validate_position(pose.lat, pose.lon)
    validate_time(t)
    cam = Camera(width, height, hfov_deg).validated()
    tcam = Camera(thermal_width, max(16, round(thermal_width * height / width)), hfov_deg).validated()
    seed = hash((round(pose.lat, 6), round(pose.lon, 6), round(pose.alt_m, 1), round(pose.heading_deg, 1),
                 round(pose.pitch_deg, 1), int(t.timestamp()))) & 0xFFFFFFFF

    hits = cast(pose, cam)
    gsd = clamp_gsd(hits.gsd_m)
    ep = epoch_for(t)
    smoky = fire_smokiness(t)
    rgb = np.zeros((cam.height, cam.width, 3), dtype=np.float32)
    labels = np.full((cam.height, cam.width), NO_DATA, dtype=np.uint8)
    used: dict = {}
    covered_frac = 0.0
    if hits.ground.any():
        g = render_ground(_points(hits), t, gsd, hits.path_factor[hits.ground], seed,
                          want_rgb=True, want_thermal=False, want_labels=include_truth)
        rgb[hits.ground] = g.rgb
        if g.labels is not None:
            labels[hits.ground] = g.labels
        used = g.layers_used
        covered_frac = float(g.covered.sum()) / hits.ground.size
        # Distant ground fades into haze.
        haze = 1.0 - np.exp(-np.nan_to_num(hits.range_m, nan=0.0) / 9000.0)
        sky_far = sky_rgb(np.zeros_like(hits.ray_elev_deg), t, smoky)
        rgb = np.where(hits.ground[..., None], rgb * (1 - haze[..., None]) + sky_far * haze[..., None], rgb)
    if (~hits.ground).any():
        sky = sky_rgb(hits.ray_elev_deg, t, smoky)
        rgb[~hits.ground] = sky[~hits.ground]

    thits = cast(pose, tcam)
    thermal = np.full((tcam.height, tcam.width), SKY_K, dtype=np.float32)
    tgsd = clamp_gsd(thits.gsd_m)
    if thits.ground.any():
        tg = render_ground(_points(thits), t, tgsd, None, seed + 1, want_rgb=False, want_thermal=True, want_labels=False)
        thermal[thits.ground] = tg.thermal_k

    fp = footprint(pose, cam)
    center = None
    if hits.ground[cam.height // 2, cam.width // 2]:
        center = (float(hits.lon[cam.height // 2, cam.width // 2]), float(hits.lat[cam.height // 2, cam.width // 2]))

    light, _, elev = lighting(t)
    env = weather_at(t)
    env["sun_elevation_deg"] = round(elev, 2)
    env["is_night"] = elev < -6
    fs = scenario()
    sat = satellite_at(t, pose.lat, pose.lon)
    poly = Polygon(fp) if len(fp) >= 3 else None
    bld = structures().within(poly, t, include_truth) if poly is not None and poly.is_valid else {"count": 0, "items": []}

    truth = None
    if include_truth:
        ground_labels = labels[hits.ground]
        counts = np.bincount(ground_labels, minlength=256)
        total = max(1, int(hits.ground.sum()))
        truth = {
            "class_fractions": {CLASS_NAMES[k]: round(int(counts[k]) / total, 4) for k in CLASS_NAMES if counts[k]},
            "fire_summary": fs.summary(t),
            "note": "Ground truth from the synthetic fire model; use for evaluating classifiers, not as a sensor.",
        }

    return Observation(
        pose=pose, camera=cam, thermal_camera=tcam, t=t,
        epoch={"name": ep.name, "synthetic": ep.synthetic, "description": ep.description},
        footprint=fp, center_ground=center, gsd_m=gsd, coverage=covered_frac,
        images=FrameImages((rgb * 255).astype(np.uint8), thermal, labels if include_truth else None),
        hotspots=_thermal_hotspots(thits, thermal, tgsd), environment=env, satellite=sat, structures=bld,
        truth=truth, sources=used,
    )


__all__ = ["observe", "Observation", "Pose", "LocationError", "TimeError", "AOI"]
