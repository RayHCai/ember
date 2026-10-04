from datetime import UTC, datetime

import numpy as np
from ember_drone_runtime.camera import CameraSpec, Frame, Images, Pose
from ember_drone_runtime.geo import LatLng
from ember_drone_runtime.link.messages import Mission
from ember_drone_runtime.mapping.evidence import EvidenceGrid, EvidenceParams
from ember_drone_runtime.mission import FlightParams, MissionBrain
from ember_drone_runtime.perception.detector import Detection2D

P = EvidenceParams()
FIRE = np.array([5, 6], dtype=np.intp)
SEEN = np.arange(20, dtype=np.intp)


def frames(grid: EvidenceGrid, confidences: list[float | None]) -> float:
    """Feed one detection per frame (None: a frame that saw the cells and found nothing)."""
    for conf in confidences:
        hits = [] if conf is None else [("on_fire", FIRE, conf)]
        grid.update(SEEN, hits)  # type: ignore[arg-type]
    return grid.posterior("on_fire", FIRE, 0.0)


def test_a_strong_detection_confirms_in_one_frame_and_a_weak_one_needs_repeats() -> None:
    assert frames(EvidenceGrid(20, P), [0.95]) >= P.confirm
    weak = EvidenceGrid(20, P)
    assert frames(weak, [0.4, 0.4]) < P.confirm
    assert frames(weak, [0.4]) >= P.confirm


def test_a_one_frame_blip_fades_and_never_confirms() -> None:
    grid = EvidenceGrid(20, P)
    assert frames(grid, [0.6]) < P.confirm
    assert frames(grid, [None, None, None]) == frames(EvidenceGrid(20, P), [])


def test_looking_clear_never_makes_a_new_fire_doubtful() -> None:
    grid = EvidenceGrid(20, P)
    frames(grid, [None] * 50)
    assert frames(grid, [0.95]) >= P.confirm


def test_a_fire_that_burns_out_drops_below_the_line() -> None:
    grid = EvidenceGrid(20, P)
    frames(grid, [0.95] * 20)
    assert frames(grid, [None] * 8) < P.confirm


def test_overlapping_detections_in_one_frame_do_not_stack() -> None:
    once, twice = EvidenceGrid(20, P), EvidenceGrid(20, P)
    once.update(SEEN, [("on_fire", FIRE, 0.5)])
    twice.update(SEEN, [("on_fire", FIRE, 0.5), ("on_fire", FIRE, 0.4)])
    assert np.array_equal(once.log_odds["on_fire"], twice.log_odds["on_fire"])


def test_peers_share_only_their_own_deltas() -> None:
    a, b = EvidenceGrid(20, P), EvidenceGrid(20, P)
    a.update(SEEN, [("on_fire", FIRE, 0.5)])
    shared = a.take_fresh()
    assert shared is not None and shared.cells == (5, 6)
    assert a.take_fresh() is None
    b.merge(shared)
    assert b.take_fresh() is None
    # b's own weak sighting plus a's is enough; neither alone was.
    b.update(SEEN, [("on_fire", FIRE, 0.5)])
    assert b.posterior("on_fire", FIRE, 0.0) >= P.confirm
    assert a.posterior("on_fire", FIRE, 0.0) < P.confirm


def test_the_brain_reports_only_confirmed_regions_with_their_posterior() -> None:
    edge = LatLng(20.879, -156.676)
    mission = Mission("run-1", "zone-1", edge, 200.0, None, 10.0, 60.0, 80.0, ("d1",))
    spec = CameraSpec(128, 96, 90.0)
    brain = MissionBrain("d1", mission, spec, FlightParams(), 0.0)
    pose = Pose(edge.lat, edge.lng, 80.0, 0.0, -90.0)
    f = Frame(1, datetime.now(UTC), pose, spec, Images(np.zeros((96, 128, 3), dtype=np.uint8)))
    weak = Detection2D("on_fire", 0.5, (60, 40, 70, 50), "flame")
    strong = Detection2D("on_fire", 0.95, (10, 10, 20, 20), "on_fire", 900.0)
    first = brain.on_frame(f, [weak, strong])
    assert [r.peak_temp_k for r in first] == [900.0]
    assert first[0].confidence >= P.confirm and first[0].confidence != 0.95
    second = brain.on_frame(f, [weak])
    assert len(second) == 1 and second[0].confidence >= P.confirm
    assert brain.detections_total == 2
