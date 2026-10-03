"""What this drone knows about the other drones of its run."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..geo import FloatArray
from ..link.messages import PeerState

# A peer silent for longer is treated as gone: it gets no goal and is not avoided by prediction.
STALE_S = 5.0


@dataclass
class Peer:
    drone_id: str
    state: PeerState
    received_at: float

    @property
    def position(self) -> FloatArray:
        return np.array(self.state.position)

    @property
    def velocity(self) -> FloatArray:
        return np.array(self.state.velocity)

    def predict(self, now: float) -> FloatArray:
        """Constant-velocity position at `now`, at most two seconds past the last message."""
        dt = min(max(0.0, now - self.received_at), 2.0)
        return self.position + self.velocity * dt

    @property
    def flying(self) -> bool:
        return self.state.phase in ("takeoff", "mapping", "returning", "landing")


class PeerTable:
    def __init__(self, members: tuple[str, ...], self_id: str) -> None:
        self.members = frozenset(members) - {self_id}
        self.peers: dict[str, Peer] = {}

    def update(self, drone_id: str, state: PeerState, now: float) -> bool:
        if drone_id not in self.members:
            return False
        self.peers[drone_id] = Peer(drone_id, state, now)
        return True

    def active(self, now: float) -> list[Peer]:
        return sorted(
            (p for p in self.peers.values() if now - p.received_at <= STALE_S),
            key=lambda p: p.drone_id,
        )
