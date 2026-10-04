import json
from typing import Any

import numpy as np
import pytest
from ember_drone_runtime.camera import CameraSpec, Pose
from ember_drone_runtime.geo import LatLng
from ember_drone_runtime.link import messages as wire
from ember_drone_runtime.link.messages import (
    LinkError,
    PeerCoverage,
    PeerEvidence,
    PeerState,
    StartMapping,
    StopMapping,
    SwarmIn,
    parse_downlink,
)
from ember_drone_runtime.perception.georef import RiskDetection


def mission(**overrides: Any) -> dict[str, Any]:
    m: dict[str, Any] = {
        "runId": "run-1",
        "zoneId": "zone-1",
        "edgeServer": {"lat": 20.879, "lng": -156.676},
        "connectivityRadiusM": 500,
        "boundary": None,
        "cellSizeM": 10,
        "altitude": {"minM": 60, "maxM": 120},
        "swarm": ["drone-1", "drone-2"],
    }
    m.update(overrides)
    return m


def test_parses_start_and_stop() -> None:
    msg = parse_downlink({"type": "start_mapping", "mission": mission()})
    assert isinstance(msg, StartMapping)
    m = msg.mission
    assert (m.run_id, m.connectivity_radius_m, m.cell_size_m) == ("run-1", 500.0, 10.0)
    assert (m.alt_min_m, m.alt_max_m, m.swarm) == (60.0, 120.0, ("drone-1", "drone-2"))
    assert m.edge_server == LatLng(20.879, -156.676)
    assert parse_downlink({"type": "stop_mapping", "runId": "run-1"}) == StopMapping("run-1")


@pytest.mark.parametrize(
    ("bad", "names"),
    [
        ({"runId": ""}, "runId"),
        ({"connectivityRadiusM": -1}, "geometry"),
        ({"altitude": {"minM": 100, "maxM": 50}}, "geometry"),
        ({"swarm": "drone-1"}, "swarm"),
        ({"boundary": [{"lat": 1, "lng": 2}]}, "boundary"),
        ({"edgeServer": {"lat": -156.676, "lng": 20.879}}, "edgeServer"),
    ],
)
def test_rejects_bad_missions_naming_the_field(bad: dict[str, Any], names: str) -> None:
    with pytest.raises(LinkError, match=names):
        parse_downlink({"type": "start_mapping", "mission": mission(**bad)})


def test_rejects_unknown_types() -> None:
    with pytest.raises(LinkError, match="unknown message type"):
        parse_downlink({"type": "launch_missiles"})


def test_swarm_messages_round_trip_through_json() -> None:
    state = PeerState(
        "2026-10-03T00:00:00Z", "mapping", (1.0, 2.0, 70.0), (3.0, 0.0, 0.0), (50.0, 60.0), 88.0
    )
    coverage = PeerCoverage((1, 2, 3), (None, 12.5, 0.0))
    evidence = PeerCoverage((), (), PeerEvidence((4, 9), (2.1, -0.7), (0.0, 1.5)))
    for raw, payload in (
        (wire.swarm_state("run-1", "drone-1", state), state),
        (wire.swarm_coverage("run-1", "drone-1", coverage), coverage),
        (wire.swarm_coverage("run-1", "drone-1", evidence), evidence),
    ):
        msg = parse_downlink(json.loads(json.dumps(raw)))
        assert msg == SwarmIn("run-1", "drone-1", payload)


def test_rejects_evidence_lists_of_different_lengths() -> None:
    raw = wire.swarm_coverage(
        "run-1", "drone-1", PeerCoverage((), (), PeerEvidence((4, 9), (2.1, -0.7), (0.0, 1.5)))
    )
    raw["payload"]["evidence"]["atRisk"] = [0.0]  # type: ignore[index]
    with pytest.raises(LinkError, match="evidence"):
        parse_downlink(raw)


def test_uplink_shapes_match_the_contract() -> None:
    spec = CameraSpec(640, 480, 84.0)
    pose = Pose(20.879, -156.676, 80.0, 370.0, -90.0)
    telemetry = wire.telemetry("d", None, 1.0, pose, spec, (1.0, 2.0, 0.0), 90.0, "patrol")
    assert set(telemetry) == {
        "type", "droneId", "sentAt", "scenarioTime", "scenarioSpeed", "pose", "camera",
        "velocity", "batteryPct", "mode",
    }  # fmt: skip
    assert telemetry["pose"] == {
        "lat": 20.879,
        "lng": -156.676,
        "altM": 80.0,
        "headingDeg": 10.0,
        "pitchDeg": -90.0,
    }
    assert telemetry["camera"] == {"widthPx": 640, "heightPx": 480, "hfovDeg": 84.0}
    risk = RiskDetection(
        "d-1-0",
        "on_fire",
        0.9,
        (1, 2, 3, 4),
        (LatLng(1, 2),) * 4,
        LatLng(1, 2),
        10.0,
        700.0,
        np.zeros((4, 2)),
    )
    det = wire.detections("d", 1, "t0", "t1", pose, spec, "heuristic", [risk])
    assert set(det) == {
        "type", "droneId", "frameId", "capturedAt", "scenarioTime", "pose", "camera", "detector",
        "detections",
    }  # fmt: skip
    detections = det["detections"]
    assert isinstance(detections, list)
    assert set(detections[0]) == {
        "id",
        "risk",
        "confidence",
        "bboxPx",
        "ground",
        "center",
        "areaM2",
        "peakTempK",
    }
