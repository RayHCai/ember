"""`demo-data serve` clock options."""

import time

import pytest
import uvicorn
from ember_demo_data import cli
from ember_demo_data.api.clock import from_env


@pytest.fixture
def no_server(monkeypatch):
    monkeypatch.delenv("EMBER_CLOCK_START", raising=False)
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: None)


def test_serve_starts_the_clock_paused_at_start(no_server):
    cli.main(["serve", "--start", "2023-08-08T15:00"])
    clock = from_env()
    first = clock.now()
    time.sleep(0.2)
    assert clock.state()["paused"]
    assert first.isoformat().startswith("2023-08-08T15:00")
    assert clock.now() == first


def test_serve_rejects_a_bad_start(no_server):
    with pytest.raises(SystemExit):
        cli.main(["serve", "--start", "3pm"])
