"""Finds an edge-connector on the local network by the mDNS announcement it makes."""

from __future__ import annotations

import asyncio
import ipaddress
import logging

from zeroconf import ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

from .messages import DRONE_LINK_PATH, EDGE_SERVICE_TYPE

log = logging.getLogger(__name__)

SERVICE = f"{EDGE_SERVICE_TYPE}.local."


def edge_url(
    addresses: list[str], port: int | None, txt: dict[bytes, bytes | None], edge_id: str | None
) -> str | None:
    """The drone-link URL an announcement points at, or None if it is unusable or another edge's."""
    found_id = (txt.get(b"id") or b"").decode()
    if not addresses or not port or (edge_id and found_id != edge_id):
        return None
    path = (txt.get(b"path") or DRONE_LINK_PATH.encode()).decode()
    # IPv4 first: link-local IPv6 needs a scope id that a URL cannot carry portably.
    addr = min(addresses, key=lambda a: ipaddress.ip_address(a).version)
    host = f"[{addr}]" if ipaddress.ip_address(addr).version == 6 else addr
    return f"ws://{host}:{port}{path}"


async def discover_edge(edge_id: str | None = None, resolve_timeout_ms: int = 3000) -> str:
    """Browses until an edge-connector (the one named `edge_id`, if given) answers; its URL."""
    loop = asyncio.get_running_loop()
    names: asyncio.Queue[str] = asyncio.Queue()

    def on_change(
        zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange
    ) -> None:
        if state_change is not ServiceStateChange.Removed:
            loop.call_soon_threadsafe(names.put_nowait, name)

    log.info("looking for edge server %s over mDNS", edge_id or "(any)")
    azc = AsyncZeroconf()
    browser = AsyncServiceBrowser(azc.zeroconf, SERVICE, handlers=[on_change])
    try:
        while True:
            name = await names.get()
            info = AsyncServiceInfo(SERVICE, name)
            if not await info.async_request(azc.zeroconf, resolve_timeout_ms):
                continue
            url = edge_url(info.parsed_addresses(), info.port, info.properties, edge_id)
            if url:
                log.info("found edge server %s at %s", name, url)
                return url
    finally:
        await browser.async_cancel()
        await azc.async_close()
