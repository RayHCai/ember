"""Fire evidence per mission-grid cell: log-odds that a cell is on fire, or at risk, accumulated
across frames and across the drones of a run.

A detection adds `gain * confidence` to the cells under its ground outline; a cell the camera saw
without a detection of that risk loses `miss`. Overlapping detections of one risk in one frame do
not stack. Log-odds stay between the prior and a ceiling. The floor is the prior because fires
ignite: no amount of looking clear makes a strong new detection doubtful. The ceiling lets a fire
that burns out drop below the confirm line within a few frames. A detection is reported once the
mean posterior of its cells reaches `confirm`, and that posterior is its confidence.

Each drone shares only the deltas its own frames applied, so nothing is counted twice.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from ..geo import FloatArray
from ..link.messages import PeerEvidence
from ..perception.detector import Risk

RISKS: tuple[Risk, ...] = ("on_fire", "at_risk")
# Deltas smaller than this are not worth telling the swarm about.
SHARE_MIN = 0.01


@dataclass(frozen=True)
class EvidenceParams:
    prior: float = 0.05
    gain: float = 3.5
    miss: float = 0.7
    ceiling: float = 4.5
    confirm: float = 0.5


def logit(p: float) -> float:
    return math.log(p / (1.0 - p))


class EvidenceGrid:
    def __init__(self, cells: int, params: EvidenceParams) -> None:
        self.p = params
        self.cells = cells
        self.floor = logit(params.prior)
        self.log_odds = {r: np.full(cells, self.floor) for r in RISKS}
        self._fresh = {r: np.zeros(cells) for r in RISKS}

    def update(
        self, seen: NDArray[np.intp], hits: list[tuple[Risk, NDArray[np.intp], float]]
    ) -> None:
        """One frame: each hit is a detection's risk, the flat cells under it and its confidence."""
        for risk in RISKS:
            mine = [(c, conf) for r, c, conf in hits if r == risk and c.size]
            hit_cells = np.zeros(0, dtype=np.intp)
            if mine:
                cells = np.concatenate([c for c, _ in mine])
                gains = np.concatenate([np.full(c.size, self.p.gain * conf) for c, conf in mine])
                hit_cells, inverse = np.unique(cells, return_inverse=True)
                best = np.zeros(hit_cells.size)
                np.maximum.at(best, inverse, gains)
                self._apply(risk, hit_cells, best, share=True)
            missed = np.setdiff1d(seen, hit_cells)
            self._apply(risk, missed, np.full(missed.size, -self.p.miss), share=True)

    def posterior(self, risk: Risk, cells: NDArray[np.intp], confidence: float) -> float:
        """Mean probability over the cells; outside the grid, what this frame alone supports."""
        if cells.size == 0:
            return 1.0 / (1.0 + math.exp(-(self.floor + self.p.gain * confidence)))
        return float(np.mean(1.0 / (1.0 + np.exp(-self.log_odds[risk][cells]))))

    def merge(self, peer: PeerEvidence) -> None:
        cells = np.asarray(peer.cells, dtype=np.intp)
        ok = (cells >= 0) & (cells < self.cells)
        layers: tuple[tuple[Risk, tuple[float, ...]], ...] = (
            ("on_fire", peer.on_fire),
            ("at_risk", peer.at_risk),
        )
        for risk, deltas in layers:
            d = np.asarray(deltas, dtype=np.float64)[ok]
            self._apply(risk, cells[ok], d, share=False)

    def take_fresh(self) -> PeerEvidence | None:
        """Deltas this drone applied since the last call, for its next coverage message."""
        on_fire, at_risk = self._fresh["on_fire"], self._fresh["at_risk"]
        idx = np.flatnonzero((np.abs(on_fire) >= SHARE_MIN) | (np.abs(at_risk) >= SHARE_MIN))
        if idx.size == 0:
            return None
        out = PeerEvidence(
            tuple(int(i) for i in idx),
            tuple(round(float(v), 2) for v in on_fire[idx]),
            tuple(round(float(v), 2) for v in at_risk[idx]),
        )
        on_fire[idx] = 0.0
        at_risk[idx] = 0.0
        return out

    def _apply(self, risk: Risk, cells: NDArray[np.intp], deltas: FloatArray, share: bool) -> None:
        if cells.size == 0:
            return
        layer = self.log_odds[risk]
        old = layer[cells]
        new = np.clip(old + deltas, self.floor, self.p.ceiling)
        layer[cells] = new
        if share:
            self._fresh[risk][cells] += new - old
