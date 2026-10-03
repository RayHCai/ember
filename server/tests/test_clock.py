import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.runtime import Runtime
from app.sim.clock import SimClock

START = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)


class FakeTime:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def sim_seconds(clock: SimClock) -> float:
    return (clock.now() - START).total_seconds()


def test_speed_sets_sim_seconds_per_real_second() -> None:
    real = FakeTime()
    clock = SimClock(speed=1, start=START, monotonic=real)
    real.t += 10
    assert sim_seconds(clock) == pytest.approx(10)

    clock.set_speed(60)
    real.t += 2
    assert sim_seconds(clock) == pytest.approx(10 + 120)

    clock.set_speed(360)
    real.t += 1
    assert sim_seconds(clock) == pytest.approx(130 + 360)


def test_pause_freezes_and_resume_continues() -> None:
    real = FakeTime()
    clock = SimClock(speed=60, start=START, monotonic=real)
    real.t += 1
    clock.pause()
    real.t += 100
    assert sim_seconds(clock) == pytest.approx(60)
    clock.resume()
    real.t += 1
    assert sim_seconds(clock) == pytest.approx(120)


def test_invalid_speed_is_rejected() -> None:
    clock = SimClock(speed=1)
    with pytest.raises(ValueError):
        clock.set_speed(0)
    with pytest.raises(ValueError):
        clock.set_speed(100_000)


@pytest.mark.anyio
async def test_sleep_follows_sim_time() -> None:
    clock = SimClock(speed=3600)
    started = time.monotonic()
    await clock.sleep(36)  # 36 sim seconds at 3600x is 10 ms real
    assert time.monotonic() - started < 0.5


def test_sim_endpoints() -> None:
    runtime = Runtime(speed=1)
    with TestClient(create_app(runtime)) as client:
        assert client.get("/sim").json()["speed"] == 1
        assert client.post("/sim/speed", json={"speed": 60}).json()["speed"] == 60
        assert client.post("/sim/pause").json()["paused"] is True
        assert client.post("/sim/resume").json()["paused"] is False
        assert client.post("/sim/speed", json={"speed": -5}).status_code == 400
    assert runtime.clock.speed == 60


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
