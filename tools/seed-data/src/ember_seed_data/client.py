"""Idempotent seeding of a Lahaina `Seed` through the api."""

from dataclasses import dataclass
from typing import Any

import httpx

from ember_seed_data.lahaina import Seed


class SeedError(Exception):
    pass


@dataclass(frozen=True)
class Summary:
    zone_id: str
    edge_servers: int
    responders_created: int
    civilians: int


def _expect(response: httpx.Response, *statuses: int) -> Any:
    if response.status_code not in statuses:
        request = response.request
        raise SeedError(
            f"{request.method} {request.url.path}: unexpected status {response.status_code}"
            f" (wanted {'/'.join(map(str, statuses))}): {response.text[:200]}"
        )
    return response.json() if response.content else None


def _ensure_zone(client: httpx.Client, seed: Seed) -> str:
    zones = _expect(client.get("/v1/watch-zones"), 200)
    for zone in zones:
        if zone["name"] == seed.zone.name:
            return str(zone["id"])
    created = _expect(
        client.post("/v1/watch-zones", json=seed.zone.model_dump(by_alias=True, mode="json")), 201
    )
    return str(created["id"])


def _ensure_civilian(client: httpx.Client, email: str, zip_code: str) -> str:
    response = client.post("/civilians", json={"email": email, "zipCode": zip_code})
    if response.status_code == 409:
        found = _expect(client.get("/v1/civilians", params={"email": email}), 200)
        if not found:
            raise SeedError(f"GET /v1/civilians: no civilian with email {email} after 409")
        return str(found[0]["id"])
    return str(_expect(response, 201)["id"])


def seed_lahaina(client: httpx.Client, seed: Seed) -> Summary:
    data = seed.to_json()
    zone_id = _ensure_zone(client, seed)
    base = f"/v1/watch-zones/{zone_id}"

    _expect(client.put(f"{base}/geography", json=data["geography"]), 200)

    for edge in data["edgeServers"]:
        _expect(client.post(f"{base}/edge-servers", json=edge), 201, 409)

    existing = {r["name"] for r in _expect(client.get(f"{base}/responders"), 200)}
    created = 0
    for responder in data["responders"]:
        if responder["name"] in existing:
            continue
        _expect(client.post(f"{base}/responders", json=responder), 201)
        created += 1

    for civilian in data["civilians"]:
        civilian_id = _ensure_civilian(client, civilian["email"], civilian["zipCode"])
        patch = {k: civilian[k] for k in ("civilianAreaId", "location", "notes")}
        _expect(client.patch(f"/v1/civilians/{civilian_id}", json=patch), 200)

    return Summary(zone_id, len(data["edgeServers"]), created, len(data["civilians"]))
