from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from .api import sim, stubs, ws, zones  # noqa: E402  (after .env is loaded)
from .runtime import Runtime  # noqa: E402

# The desktop app's origins in a bundled build. Any localhost port is allowed
# too: the Vite dev server (what the app loads in development) and test servers.
ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost"]
LOCALHOST_ORIGIN = r"http://(localhost|127\.0\.0\.1)(:\d+)?"


def create_app(runtime: Runtime | None = None) -> FastAPI:
    runtime = runtime or Runtime()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await runtime.start()
        yield
        await runtime.stop()

    app = FastAPI(title="Ember", lifespan=lifespan)
    app.state.runtime = runtime
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=LOCALHOST_ORIGIN,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(sim.router)
    app.include_router(ws.router)
    app.include_router(zones.router)
    app.include_router(stubs.router)
    return app


app = create_app()
