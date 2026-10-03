"""Console state rebuilt from events, so a new client can get a snapshot."""

from __future__ import annotations

from collections import deque

LOG_KINDS = {"log", "spread", "route", "dispatch", "alert", "approval_request", "decision"}
LOG_LIMIT = 500
NOTIFICATION_LIMIT = 300


def approval_id(event: dict) -> str:
    payload = event["payload"]
    return str(payload.get("id") or payload.get("approval_id") or f"{event['zone_id']}:{event['ts']}")


class ConsoleState:
    def __init__(self) -> None:
        self.zones: dict[str, dict] = {}
        self.zone_maps: dict[str, dict] = {}
        self.edge_plans: dict[str, dict] = {}
        self.drones: dict[str, dict] = {}
        self.surveys: dict[str, dict] = {}
        self.reports: dict[str, dict] = {}
        self.captures: dict[str, dict] = {}
        self.incidents: dict[str, dict] = {}
        self.approvals: dict[str, dict] = {}
        self.notifications: deque[dict] = deque(maxlen=NOTIFICATION_LIMIT)
        self.suppression: dict[str, dict] = {}
        self.log: deque[dict] = deque(maxlen=LOG_LIMIT)

    def apply(self, event: dict) -> None:
        kind, zone_id, payload = event["kind"], event["zone_id"], event["payload"]
        zoned = {**payload, "zone_id": zone_id} if isinstance(payload, dict) else payload

        if kind in LOG_KINDS:
            self.log.append(event)

        if kind == "zone":
            self.zones[payload["id"]] = payload
        elif kind == "zone_map":
            self.zone_maps[zone_id] = payload
        elif kind == "zone_removed":
            self.forget_zone(zone_id)
        elif kind == "edge_plan":
            self.edge_plans[zone_id] = payload
        elif kind == "drone":
            self.drones[payload["id"]] = payload
        elif kind == "survey":
            self.surveys[zone_id] = payload
        elif kind == "report":
            self.reports[zone_id] = payload
        elif kind == "capture":
            self.captures[payload["id"]] = zoned
        elif kind == "incident":
            self.incidents[payload["id"]] = zoned
        elif kind == "notification":
            kept = [n for n in self.notifications if n["id"] != payload["id"]]
            self.notifications.clear()
            self.notifications.extend(kept)
            self.notifications.append(zoned)
        elif kind == "suppression":
            self.suppression[payload["incident_id"]] = zoned
        elif kind == "approval_request":
            self.approvals[approval_id(event)] = event
        elif kind == "decision":
            resolved = payload.get("approval_id")
            if resolved:
                self.approvals.pop(str(resolved), None)

    def forget_zone(self, zone_id: str) -> None:
        self.zones.pop(zone_id, None)
        self.zone_maps.pop(zone_id, None)
        self.edge_plans.pop(zone_id, None)
        self.surveys.pop(zone_id, None)
        self.reports.pop(zone_id, None)
        for table in (self.captures, self.incidents, self.suppression):
            for key in [k for k, v in table.items() if v.get("zone_id") == zone_id]:
                del table[key]
        for key in [k for k, v in self.approvals.items() if v["zone_id"] == zone_id]:
            del self.approvals[key]
        self.drones = {k: v for k, v in self.drones.items() if v.get("zone_id") != zone_id}

    def snapshot(self, sim: dict) -> dict:
        return {
            "sim": sim,
            "zones": list(self.zones.values()),
            "zone_maps": self.zone_maps,
            "edge_plans": self.edge_plans,
            "drones": list(self.drones.values()),
            "surveys": self.surveys,
            "reports": self.reports,
            "captures": list(self.captures.values()),
            "incidents": list(self.incidents.values()),
            "approvals": list(self.approvals.values()),
            "notifications": list(self.notifications),
            "suppression": list(self.suppression.values()),
            "log": list(self.log),
        }
