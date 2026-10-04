"""`demo-data serve` clock options."""

import time

import pytest
import uvicorn
from ember_demo_data import cli
from ember_demo_data.api.clock import from_env


@pytest.fixture
def no_server(monkeypatch):
    monkeypatch.delenv("EMBER_CLOCK_SPEED", raising=False)
    monkeypatch.delenv("EMBER_CLOCK_START", raising=False)
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: None)


def test_serve_sets_the_clock_speed_and_start(no_server):
    cli.main(["serve", "--speed", "30", "--start", "2023-08-08T15:00"])
    clock = from_env()
    first = clock.now()
    time.sleep(0.2)
    advanced = (clock.now() - first).total_seconds()
    assert clock.state()["speed"] == 30
    assert first.isoformat().startswith("2023-08-08T15:00")
    assert 4 <= advanced <= 9  # 0.2 s of wall time at 30x


@pytest.mark.parametrize("bad", [["--speed", "0"], ["--speed", "5000"], ["--start", "3pm"]])
def test_serve_rejects_bad_clock_options(no_server, bad):
    with pytest.raises(SystemExit):
        cli.main(["serve", *bad])
