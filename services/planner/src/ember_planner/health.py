"""`GET /healthz` on a background thread; the caller owns the returned server and shuts it down."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .wire import Json

SERVICE_HEALTH_PATH = "/healthz"


def serve_health(
    service: str, port: int, report: Callable[[], Json] = dict, host: str = ""
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != SERVICE_HEALTH_PATH:
                self.send_error(404)
                return
            body = json.dumps({"service": service, "ok": True, **report()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, name=f"{service}-health", daemon=True).start()
    return server
