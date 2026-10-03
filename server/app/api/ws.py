import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..bus import RESYNC, Subscriber

router = APIRouter()


async def _forward(websocket: WebSocket, sub: Subscriber) -> None:
    while True:
        event = await sub.queue.get()
        if event is RESYNC:
            # This client fell too far behind. Closing makes it reconnect
            # and start again from a fresh snapshot.
            await websocket.close(code=1013, reason="Too far behind, reconnect")
            return
        await websocket.send_json(event)


async def _until_disconnect(websocket: WebSocket) -> None:
    # Clients never send anything we act on, but receiving is how we learn the
    # socket closed, including when the server itself is shutting down.
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return


@router.websocket("/ws")
async def event_stream(websocket: WebSocket) -> None:
    """Send one snapshot, then every event as it happens."""
    runtime = websocket.app.state.runtime
    await websocket.accept()
    sub, snapshot = runtime.bus.subscribe()
    tasks: list[asyncio.Task] = []
    try:
        await websocket.send_json(snapshot)
        tasks = [
            asyncio.create_task(_forward(websocket, sub)),
            asyncio.create_task(_until_disconnect(websocket)),
        ]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        runtime.bus.unsubscribe(sub)
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await task
