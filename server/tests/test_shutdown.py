"""The server must exit promptly on SIGTERM even with consoles connected.

The desktop app stops the server with SIGTERM when it quits. A WebSocket
handler that never notices the disconnect keeps uvicorn waiting forever.
"""

import asyncio
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import websockets

SERVER_DIR = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def connect(port: int):
    deadline = time.monotonic() + 15
    while True:
        try:
            return await websockets.connect(f"ws://127.0.0.1:{port}/ws")
        except OSError:
            if time.monotonic() > deadline:
                raise
            await asyncio.sleep(0.2)


async def stop_with_console_open(proc: subprocess.Popen, port: int) -> tuple[float, str]:
    ws = await connect(port)
    assert json.loads(await ws.recv())["kind"] == "snapshot"
    started = time.monotonic()
    proc.terminate()
    # The console stays connected (its loop keeps running) while the server stops.
    _, log = await asyncio.to_thread(proc.communicate, timeout=5)
    elapsed = time.monotonic() - started
    await ws.close()
    return elapsed, log


def test_sigterm_with_open_websocket_exits_quickly() -> None:
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=SERVER_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        elapsed, log = asyncio.run(stop_with_console_open(proc, port))
        assert elapsed < 5
        # uvicorn re-raises the signal after a clean shutdown, so the exit code
        # is -15 either way. The log line proves the lifespan shutdown ran.
        assert "Application shutdown complete" in log
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
