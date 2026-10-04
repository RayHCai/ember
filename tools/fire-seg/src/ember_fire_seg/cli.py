"""fire-seg: stage sources, assemble the dataset, train, export, evaluate. See README.md."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
from typing import Any

from .classes import CLASSES, class_index
from .dataset import assemble
from .sources import SourceInfo, source_dir, stage_mask_pairs, stage_yolo_det, stage_yolo_seg

_REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_ROOT = Path(os.environ.get("EMBER_FIRE_SEG_DIR", _REPO_ROOT / "data" / "fire-seg"))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="fire-seg", description=__doc__)
    p.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="working directory for data")
    sub = p.add_subparsers(dest="command", required=True)

    def source_args(s: argparse.ArgumentParser) -> None:
        s.add_argument("--name", required=True, help="source name (folder under sources/)")
        s.add_argument("--license", default="unknown", help="licence, recorded in the manifest")
        s.add_argument(
            "--aerial", action="store_true", help="drone/aircraft view; eligible for test"
        )
        s.add_argument(
            "--group-block", type=int, default=1, help="consecutive frames that split together"
        )

    s = sub.add_parser("stage-yolo-seg", help="a YOLO segmentation export (Roboflow)")
    s.add_argument("src", type=Path)
    s.add_argument("--names", help="class names in order, comma-separated (default: data.yaml)")
    source_args(s)

    s = sub.add_parser("stage-yolo-det", help="a YOLO detection dataset (D-Fire), masks by SAM 2")
    s.add_argument("src", type=Path)
    s.add_argument("--names", help="class names in order (D-Fire: smoke,fire)")
    s.add_argument("--sam", default="sam2.1_b.pt", help="Ultralytics SAM weights")
    s.add_argument("--device", default="auto")
    source_args(s)

    s = sub.add_parser("stage-mask-pairs", help="images with binary masks of one class (FLAME)")
    s.add_argument("images", type=Path)
    s.add_argument("masks", type=Path)
    s.add_argument("--class", dest="cls", default="flame", choices=CLASSES)
    s.add_argument("--mask-suffix", default="", help="mask stem = image stem + this")
    source_args(s)

    s = sub.add_parser("stage-demo-data", help="frames and truth labels from a running Demo Data")
    s.add_argument("--url", default="http://localhost:8090")
    s.add_argument("--count", type=int, default=600)
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--name", default="demo-data")

    s = sub.add_parser("assemble", help="merge staged sources into dataset/")
    s.add_argument("--sources", help="comma-separated (default: every staged source)")
    s.add_argument("--test-sources", help="comma-separated (default: real aerial sources)")
    s.add_argument("--test-frac", type=float, default=0.25)
    s.add_argument("--val-frac", type=float, default=0.1)
    s.add_argument("--synthetic-cap", type=float, default=0.3)
    s.add_argument("--seed", type=int, default=0)

    s = sub.add_parser("train", help="train on dataset/, export ONNX to models/, evaluate on test")
    s.add_argument("--name", default="fire-seg")
    s.add_argument("--model", default="yolo11n-seg.pt", help="base weights or a model yaml")
    s.add_argument("--epochs", type=int, default=50)
    s.add_argument("--imgsz", type=int, default=416)
    s.add_argument("--batch", type=int, default=16)
    s.add_argument("--device", default="auto", help="auto, cpu, mps or a CUDA index")
    s.add_argument("--workers", type=int, default=4)
    s.add_argument("--patience", type=int, default=20)
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--resume", type=Path, help="a run's weights/last.pt to continue")

    s = sub.add_parser("export", help="re-export trained weights to ONNX with a model card")
    s.add_argument("weights", type=Path)
    s.add_argument("--imgsz", type=int, default=416)
    s.add_argument("--out", type=Path, help="default: models/<run name>.onnx")

    s = sub.add_parser("evaluate", help="mask IoU of an ONNX model through drone-runtime")
    s.add_argument("model", type=Path)
    s.add_argument("--split", default="test", help="dataset split, or a path to an images folder")
    s.add_argument("--conf", type=float, default=0.3)
    s.add_argument("--limit", type=int)
    s.add_argument("--no-baseline", action="store_true")
    s.add_argument("--out", type=Path, help="write the report as JSON")

    sub.add_parser("smoke", help="the whole pipeline on procedural images, 1 epoch on CPU")

    args = p.parse_args(argv)
    root: Path = args.root
    cmd = args.command
    if cmd == "stage-yolo-seg":
        _print_info(
            stage_yolo_seg(
                args.src, source_dir(root, args.name), _info(args, "yolo-seg"), _names(args.names)
            )
        )
    elif cmd == "stage-yolo-det":
        from .train import pick_device

        _print_info(
            stage_yolo_det(
                args.src,
                source_dir(root, args.name),
                _info(args, "yolo-det"),
                _names(args.names),
                args.sam,
                pick_device(args.device),
            )
        )
    elif cmd == "stage-mask-pairs":
        _print_info(
            stage_mask_pairs(
                args.images,
                args.masks,
                source_dir(root, args.name),
                _info(args, "mask-pairs"),
                class_index(args.cls),
                args.mask_suffix,
            )
        )
    elif cmd == "stage-demo-data":
        from .demo_data import stage_demo_data

        _print_info(
            stage_demo_data(args.url, source_dir(root, args.name), args.name, args.count, args.seed)
        )
    elif cmd == "assemble":
        manifest = assemble(
            root,
            root / "dataset",
            _names(args.sources),
            _names(args.test_sources),
            args.test_frac,
            args.val_frac,
            args.synthetic_cap,
            args.seed,
        )
        print(json.dumps({k: manifest[k] for k in ("version", "images", "instances")}, indent=2))
    elif cmd == "train":
        _train(root, args)
    elif cmd == "export":
        from .train import export

        out = args.out or root / "models" / f"{args.weights.parent.parent.name}.onnx"
        dataset = root / "dataset"
        print(export(args.weights, out, args.imgsz, dataset if dataset.is_dir() else None))
    elif cmd == "evaluate":
        split = Path(args.split)
        if not split.is_dir():
            split = root / "dataset" / "images" / args.split
        _evaluate(args.model, split, args.conf, args.limit, not args.no_baseline, args.out)
    elif cmd == "smoke":
        _smoke(root / "smoke")


def _train(root: Path, args: argparse.Namespace) -> None:
    from .train import export, pick_device, train

    dataset = root / "dataset"
    if args.resume is None and not (dataset / "data.yaml").is_file():
        raise SystemExit(f"no dataset at {dataset}: run `fire-seg assemble` first")
    device = pick_device(args.device)
    best, metrics = train(
        dataset / "data.yaml",
        root / "runs",
        args.name,
        model=args.model,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        workers=args.workers,
        patience=args.patience,
        seed=args.seed,
        resume=args.resume,
    )
    out = root / "models" / f"{best.parent.parent.name}.onnx"
    extra = {"base_model": args.model, "epochs": args.epochs, "device": device}
    onnx = export(best, out, args.imgsz, dataset, metrics, extra)
    print(f"exported {onnx}")
    test = dataset / "images" / "test"
    if test.is_dir() and any(test.iterdir()):
        report = _evaluate(onnx, test, 0.3, None, True, onnx.with_suffix(".eval.json"))
        card_path = onnx.with_suffix(".json")
        card = json.loads(card_path.read_text())
        card["test_metrics"] = report["classes"]
        card_path.write_text(json.dumps(card, indent=2) + "\n")


def _evaluate(
    model: Path, split: Path, conf: float, limit: int | None, baseline: bool, out: Path | None
) -> dict[str, Any]:
    from ember_drone_runtime.perception import HeuristicDetector
    from ember_drone_runtime.perception.yolo import YoloDetector

    from .evaluate import evaluate, summary

    report = evaluate(
        YoloDetector(model, conf=conf), split, HeuristicDetector() if baseline else None, limit
    )
    print(summary(report))
    if out is not None:
        out.write_text(json.dumps(report, indent=2) + "\n")
    return report


def _smoke(root: Path) -> None:
    from ember_drone_runtime.perception.yolo import YoloDetector

    from .evaluate import evaluate, summary
    from .synthetic import stage_synthetic
    from .train import export, train

    if root.exists():
        shutil.rmtree(root)
    stage_synthetic(source_dir(root, "synthetic"), "synthetic", count=48)
    dataset = root / "dataset"
    assemble(
        root, dataset, test_sources=["synthetic"], test_frac=0.2, val_frac=0.2, synthetic_cap=1
    )
    best, metrics = train(
        dataset / "data.yaml",
        root / "runs",
        "smoke",
        model="yolo11n-seg.yaml",
        epochs=1,
        imgsz=160,
        batch=8,
        device="cpu",
        workers=0,
        plots=False,
    )
    onnx = export(best, root / "models" / "smoke.onnx", 160, dataset, metrics)
    # An untrained model scores nearly nothing; a near-zero threshold still drives mask decoding.
    detector = YoloDetector(onnx, conf=0.001)
    if detector.names != list(CLASSES) or detector.mask_dim == 0:
        raise SystemExit(f"export lost the segmentation head or names: {detector.names}")
    report = evaluate(detector, dataset / "images" / "test", limit=8)
    print(summary(report))
    print(f"smoke OK: {onnx} ({detector.mask_dim} mask prototypes, {len(CLASSES)} classes)")


def _info(args: argparse.Namespace, kind: str) -> SourceInfo:
    return SourceInfo(
        name=args.name,
        kind=kind,
        synthetic=False,
        aerial=args.aerial,
        group_block=args.group_block,
        license=args.license,
        origin=str(getattr(args, "src", None) or getattr(args, "images", "")),
    )


def _names(value: str | None) -> list[str] | None:
    return None if not value else [v.strip() for v in value.split(",") if v.strip()]


def _print_info(info: SourceInfo) -> None:
    print(f"{info.name}: {info.images} images, instances {info.instances}, notes {info.notes}")
