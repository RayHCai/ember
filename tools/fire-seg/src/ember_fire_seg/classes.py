"""The model's classes and how other datasets' class names map onto them.

drone-runtime maps these names to risks by keyword (`perception/yolo.py`): flame is `on_fire`,
smoke and burned are `at_risk`. Dry fuel is not a class; fuel maps and the planner own it.
"""

from __future__ import annotations

CLASSES = ("flame", "smoke", "burned")
FLAME, SMOKE, BURNED = range(3)

# Smoke first so "fire_smoke" is smoke; "burning" is flame, never burned.
_WORDS = (
    (SMOKE, ("smoke", "haze", "plume")),
    (BURNED, ("burned", "burnt", "scar", "char", "ash")),
    (FLAME, ("fire", "flame", "burning", "blaze")),
)


def class_for_name(name: str) -> int | None:
    """Our class for another dataset's class name, or None to drop it."""
    n = name.lower().replace("-", "_").replace(" ", "_")
    for cls, words in _WORDS:
        if any(w in n for w in words):
            return cls
    return None


def class_index(name: str) -> int:
    """Index of one of our class names, accepting other datasets' names too."""
    if name in CLASSES:
        return CLASSES.index(name)
    cls = class_for_name(name)
    if cls is None:
        raise ValueError(f"{name!r} is none of {CLASSES}")
    return cls
