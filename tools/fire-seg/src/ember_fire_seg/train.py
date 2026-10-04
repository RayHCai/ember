"""Train with Ultralytics, export ONNX for drone-runtime, and write a model card beside it.

Needs the `train` extra (ultralytics, torch). The ONNX keeps Ultralytics' `names` metadata, which
is how the drone learns the classes; NMS stays out of the graph because the runtime does its own.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .classes import CLASSES

BASE_MODEL = "yolo11n-seg.pt"
# Old enough for any onnxruntime a Pi will have, new enough for every op YOLO11 uses.
OPSET = 17


def _ultralytics() -> Any:
    try:
        import ultralytics
    except ImportError as exc:
        raise RuntimeError(
            "training needs the train extra: uv sync --package ember-fire-seg --extra train"
        ) from exc
    return ultralytics


def pick_device(requested: str = "auto") -> str:
    """`auto` is the first of CUDA, Apple's MPS and CPU that is available."""
    if requested != "auto":
        return requested
    import torch

    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train(
    data: Path,
    runs: Path,
    name: str,
    model: str = BASE_MODEL,
    epochs: int = 50,
    imgsz: int = 416,
    batch: int = 16,
    device: str = "auto",
    workers: int = 4,
    patience: int = 20,
    seed: int = 0,
    plots: bool = True,
    resume: Path | None = None,
) -> tuple[Path, dict[str, float]]:
    """Best weights and their validation metrics."""
    yolo = _ultralytics().YOLO
    if resume is not None:
        trainer = yolo(str(resume))
        results = trainer.train(resume=True)
    else:
        trainer = yolo(model)
        results = trainer.train(
            data=str(data),
            epochs=epochs,
            imgsz=imgsz,
            batch=batch,
            device=pick_device(device),
            workers=workers,
            patience=patience,
            seed=seed,
            plots=plots,
            project=str(runs),
            name=name,
            exist_ok=False,
        )
    metrics = getattr(results, "results_dict", None) or {}
    return Path(trainer.trainer.best), {str(k): float(v) for k, v in metrics.items()}


def export(
    weights: Path,
    out: Path,
    imgsz: int,
    dataset: Path | None = None,
    metrics: dict[str, float] | None = None,
    extra: dict[str, Any] | None = None,
) -> Path:
    """`out` (.onnx) and its model card `out.with_suffix('.json')`."""
    ultralytics = _ultralytics()
    model = ultralytics.YOLO(str(weights))
    names = [str(model.names[k]) for k in sorted(model.names)]
    if names != list(CLASSES):
        raise ValueError(f"{weights}: classes {names}, expected {list(CLASSES)}")
    exported = Path(
        model.export(format="onnx", imgsz=imgsz, opset=OPSET, simplify=True, dynamic=False)
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported, out)
    manifest = _read_manifest(dataset)
    card: dict[str, Any] = {
        "file": out.name,
        "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "classes": names,
        "imgsz": imgsz,
        "opset": OPSET,
        "weights": str(weights),
        "git": _git(),
        "dataset": None
        if manifest is None
        else {
            "version": manifest.get("version"),
            "images": manifest.get("images"),
            "path": str(dataset),
        },
        "val_metrics": metrics or {},
        "ultralytics": ultralytics.__version__,
        **(extra or {}),
    }
    out.with_suffix(".json").write_text(json.dumps(card, indent=2) + "\n")
    return out


def _read_manifest(dataset: Path | None) -> dict[str, Any] | None:
    if dataset is None or not (dataset / "manifest.json").is_file():
        return None
    data: dict[str, Any] = json.loads((dataset / "manifest.json").read_text())
    return data


def _git() -> dict[str, Any] | None:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return {"commit": commit, "dirty": bool(dirty)}
