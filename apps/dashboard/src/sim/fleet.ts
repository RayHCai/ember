import { offset } from './geo';
import { getTelemetry, setTelemetry } from './live';
import type { Drone, EdgeServer, LatLon, WatchZone } from './types';

/** Docked drones sit in a small ring around their edge server. */
export function dockPosition(server: EdgeServer, slot: number): LatLon {
    const a = (slot * 2 * Math.PI) / 4 + Math.PI / 4;
    return offset([server.lat, server.lon], Math.sin(a) * 70, Math.cos(a) * 70);
}

export function dockSlot(zone: WatchZone, drone: Drone): number {
    return zone.drones
        .filter((d) => d.serverId === drone.serverId)
        .findIndex((d) => d.id === drone.id);
}

export function dockDrone(zone: WatchZone, drone: Drone, battery?: number): void {
    const server = zone.servers.find((s) => s.id === drone.serverId);
    if (!server) return;
    const [lat, lon] = dockPosition(server, Math.max(0, dockSlot(zone, drone)));
    const previous = getTelemetry(drone.id);
    const batteryPct = battery ?? previous?.batteryPct ?? 72 + Math.round(Math.random() * 28);
    setTelemetry(drone.id, {
        lat,
        lon,
        altM: 0,
        headingDeg: 0,
        speedMs: 0,
        batteryPct,
        signalPct: 92 + Math.round(Math.random() * 8),
        state: batteryPct < 99 ? 'charging' : 'docked',
        lastSeenAt: Date.now(),
    });
}

export function dockFleet(zone: WatchZone): void {
    for (const drone of zone.drones) if (!getTelemetry(drone.id)) dockDrone(zone, drone);
}
