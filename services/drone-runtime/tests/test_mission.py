import math

import numpy as np
from ember_drone_runtime.camera import CameraSpec, Images, Pose
from ember_drone_runtime.flight import VehicleState
from ember_drone_runtime.geo import LatLng, LocalFrame
from ember_drone_runtime.link.messages import Mission
from ember_drone_runtime.lockstep import Lockstep
from ember_drone_runtime.mission import FlightParams, MissionBrain
from ember_drone_runtime.perception import HeuristicDetector
from ember_drone_runtime.sensors.synthetic import demo_world

EDGE = LatLng(20.879, -156.676)
SPEC = CameraSpec(96, 72, 84.0)


def mission(radius_m: float = 200.0, swarm: tuple[str, ...] = ("a",)) -> Mission:
    return Mission("run", "zone", EDGE, radius_m, None, 10.0, 60.0, 120.0, swarm)


def vehicle(z: float = 0.0, airborne: bool = False, battery: float = 100.0) -> VehicleState:
    return VehicleState(EDGE.lat, EDGE.lng, z, (0.0, 0.0, 0.0), 0.0, battery, airborne)


def flying_brain(now: float = 0.0) -> MissionBrain:
    brain = MissionBrain("a", mission(), SPEC, FlightParams(), now)
    brain.control(now, vehicle(airborne=True, z=60.0))
    assert brain.phase == "mapping"
    return brain


def test_takes_off_then_climbs_to_its_band() -> None:
    brain = MissionBrain("b", mission(swarm=("a", "b", "c")), SPEC, FlightParams(), 0.0)
    assert brain.cruise_agl_m == 70.0
    assert brain.control(0.0, vehicle()).action == "takeoff"
    climb = brain.control(0.1, vehicle(z=10.0, airborne=True))
    assert brain.phase == "takeoff" and climb.velocity[2] > 0


def away(battery: float = 100.0) -> VehicleState:
    p = LocalFrame(EDGE).latlng(100.0, 0.0)
    return VehicleState(p.lat, p.lng, 60.0, (0.0, 0.0, 0.0), 0.0, battery, True)


def test_edge_link_loss_sends_it_home() -> None:
    brain = flying_brain()
    brain.control(25.0, away())
    assert (brain.phase, brain.reason) == ("returning", "edge link lost")


def test_low_battery_sends_it_home() -> None:
    brain = flying_brain()
    brain.control(1.0, away(battery=10.0))
    assert brain.phase == "returning" and brain.reason.startswith("battery")


def test_stop_sends_it_home() -> None:
    brain = flying_brain()
    brain.stop("stopped by edge")
    cmd = brain.control(1.0, away())
    assert (brain.phase, brain.reason) == ("returning", "stopped by edge")
    assert cmd.velocity[0] < 0  # towards home, west of here


def test_lands_where_it_took_off() -> None:
    brain = flying_brain()
    brain.stop("done")
    assert brain.control(1.0, vehicle(z=60.0, airborne=True)).action == "land"
    assert brain.phase == "landing"
    brain.control(2.0, vehicle(z=0.0, airborne=False))
    assert brain.phase == "landed"


def test_a_swarm_maps_the_whole_radius_safely_and_finds_the_fires() -> None:
    radius = 200.0
    world = demo_world(EDGE, radius)
    local = LocalFrame(EDGE)
    ids = ("a", "b", "c")
    homes = []
    for i, d in enumerate(ids):
        p = local.latlng(12 * math.cos(2 * math.pi * i / 3), 12 * math.sin(2 * math.pi * i / 3))
        homes.append((d, p.lat, p.lng))

    def render(pose: Pose, spec: CameraSpec) -> Images:
        x, y = world.local.point_xy(pose.lat, pose.lng)
        return world.render(np.array([x, y, pose.alt_m]), pose.heading_deg, pose.pitch_deg, spec)

    params = FlightParams()
    report = Lockstep(mission(radius, ids), homes, render, HeuristicDetector(), SPEC, params).run(
        900
    )

    assert report.landed, f"not all landed after {report.seconds} s"
    assert report.coverage >= params.coverage_target
    assert report.min_separation_m >= 10.0
    assert report.max_radius_m <= radius - params.geofence_margin_m + 2.0
    fires = [(f.x, f.y, f.radius_m) for f in world.fires]
    on_fire = [local.point(d.center) for d in report.detections if d.risk == "on_fire"]
    beyond = [min(math.hypot(x - fx, y - fy) - fr for fx, fy, fr in fires) for x, y in on_fire]
    assert np.median(beyond) < 0, "fire detections should sit on the fires"
    for fx, fy, fr in fires:
        assert any(math.hypot(x - fx, y - fy) < fr for x, y in on_fire), (
            f"missed the fire at {fx, fy}"
        )
