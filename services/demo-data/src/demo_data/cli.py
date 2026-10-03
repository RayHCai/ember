"""Command line: download source data, build derived rasters, verify georeferencing, serve."""

from __future__ import annotations

import argparse
import logging
import sys


def _download(args: argparse.Namespace) -> None:
    from .config import LAYERS
    from .ingest import imagery, sources

    steps = args.only or ["imagery", *sources.STEPS]
    for step in steps:
        if step == "imagery":
            for layer in LAYERS.values():
                if args.layer and layer.id not in args.layer:
                    continue
                stats = imagery.download_layer(layer, workers=args.workers, max_zoom=args.max_zoom)
                logging.info("%s: downloaded %s", layer.id, stats)
        else:
            sources.STEPS[step](force=args.force)


def _build(args: argparse.Namespace) -> None:
    from . import verify
    from .model import build

    from .config import DERIVED_DIR

    build.build_all(force=args.force)
    if args.force or not (DERIVED_DIR / "coregistration.json").exists():
        verify.coregister()
    _world(args)


def _world(args: argparse.Namespace) -> None:
    from .world import store

    meta = store.build(force=args.force)
    logging.info("world: %d trees, %d buildings", meta["vegetation_count"], meta["building_count"])


def _verify(args: argparse.Namespace) -> None:
    from . import verify

    ok = verify.run_all()
    sys.exit(0 if ok else 1)


def _serve(args: argparse.Namespace) -> None:
    import uvicorn

    uvicorn.run("demo_data.api.app:app", host=args.host, port=args.port, log_level="info")


def _render(args: argparse.Namespace) -> None:
    from datetime import datetime

    from .render.observe import Pose, observe
    from .config import HST

    t = datetime.fromisoformat(args.t)
    if t.tzinfo is None:
        t = t.replace(tzinfo=HST)
    pose = Pose(lat=args.lat, lon=args.lon, alt_m=args.alt, heading_deg=args.heading, pitch_deg=args.pitch)
    obs = observe(pose, t, width=args.width, height=args.height, hfov_deg=args.fov, include_truth=True)
    prefix = args.out
    obs.images.rgb_image().save(f"{prefix}_rgb.jpg", quality=90)
    obs.images.thermal_preview().save(f"{prefix}_thermal.png")
    obs.images.labels_preview().save(f"{prefix}_labels.png")
    import json

    print(json.dumps(obs.metadata(), indent=2, default=str))


TIMELINE = ["2023-08-08T15:10", "2023-08-08T15:40", "2023-08-08T16:30", "2023-08-08T17:30",
            "2023-08-08T18:45", "2023-08-08T20:00", "2023-08-08T22:30", "2023-08-09T03:00",
            "2023-08-09T13:00", "2023-08-15T10:00"]


def _timeline(args: argparse.Namespace) -> None:
    """One row per moment: RGB, thermal and ground-truth labels side by side."""
    from datetime import datetime

    from PIL import Image, ImageDraw

    from .config import HST
    from .render.observe import Pose, observe

    pose = Pose(lat=args.lat, lon=args.lon, alt_m=args.alt, heading_deg=args.heading, pitch_deg=args.pitch)
    times = args.times or TIMELINE
    sheet = Image.new("RGB", (960, 240 * len(times)))
    for i, ts in enumerate(times):
        t = datetime.fromisoformat(ts)
        t = t if t.tzinfo else t.replace(tzinfo=HST)
        obs = observe(pose, t, include_truth=True)
        imgs = [obs.images.rgb_image(), obs.images.thermal_preview(), obs.images.labels_preview()]
        for j, im in enumerate(imgs):
            im = im.resize((320, 240))
            ImageDraw.Draw(im).text((4, 4), f"{t:%b %d %H:%M} HST  {obs.epoch['name']}", fill=(255, 255, 255))
            sheet.paste(im, (j * 320, i * 240))
        logging.info("%s %s", ts, obs.truth["class_fractions"])
    sheet.save(args.out)
    print(f"wrote {args.out}")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="demo-data", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("download", help="download source data into data/")
    d.add_argument("--only", nargs="*", help="steps to run (imagery, perimeter, sentinel2, ...)")
    d.add_argument("--layer", nargs="*", help="imagery layer ids to download")
    d.add_argument("--workers", type=int, default=8)
    d.add_argument("--max-zoom", type=int, default=None)
    d.add_argument("--force", action="store_true")
    d.set_defaults(func=_download)

    b = sub.add_parser("build", help="build derived rasters (burn scar, fuels, fire arrival times)")
    b.add_argument("--force", action="store_true")
    b.set_defaults(func=_build)

    w = sub.add_parser("world", help="build the 3D viewer's world assets (trees, buildings, fire grid, imagery)")
    w.add_argument("--force", action="store_true")
    w.set_defaults(func=_world)

    v = sub.add_parser("verify", help="check georeferencing of every layer and the fire model")
    v.set_defaults(func=_verify)

    s = sub.add_parser("serve", help="run the HTTP/WebSocket API")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8090)
    s.set_defaults(func=_serve)

    r = sub.add_parser("render", help="render one observation to files (debugging)")
    r.add_argument("--lat", type=float, required=True)
    r.add_argument("--lon", type=float, required=True)
    r.add_argument("--alt", type=float, default=120.0)
    r.add_argument("--heading", type=float, default=0.0)
    r.add_argument("--pitch", type=float, default=-90.0)
    r.add_argument("--t", required=True, help="scenario time, ISO 8601 (HST if no offset)")
    r.add_argument("--width", type=int, default=640)
    r.add_argument("--height", type=int, default=480)
    r.add_argument("--fov", type=float, default=84.0)
    r.add_argument("--out", default="frame")
    r.set_defaults(func=_render)

    tl = sub.add_parser("timeline", help="contact sheet of one view across the fire (RGB | thermal | labels)")
    tl.add_argument("--lat", type=float, required=True)
    tl.add_argument("--lon", type=float, required=True)
    tl.add_argument("--alt", type=float, default=180.0)
    tl.add_argument("--heading", type=float, default=0.0)
    tl.add_argument("--pitch", type=float, default=-90.0)
    tl.add_argument("--times", nargs="*", help="ISO times (HST if no offset); default: a preset list")
    tl.add_argument("--out", default="timeline.png")
    tl.set_defaults(func=_timeline)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
