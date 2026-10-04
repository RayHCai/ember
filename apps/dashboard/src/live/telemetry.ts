import type { DroneKind, DroneMode, DroneSummary, DroneTelemetry } from '@ember/contracts';

// Drone positions change many times a second. They live here, outside React and the stores: map
// layers read them each frame, panels poll them a few times a second.

export interface Telemetry {
    lat: number;
    lon: number;
    altM: number;
    headingDeg: number;
    speedMs: number;
    batteryPct: number;
    mode: DroneMode;
    /** Metres per second east and north, for drawing between reports; zero from fleet snapshots. */
    eastMps: number;
    northMps: number;
    /** `performance.now()` when it arrived, and the drone's own report time. */
    receivedAt: number;
    lastSeenAt: number;
    name: string;
    kind: DroneKind;
    /** From the drone's own telemetry rather than the once-a-second fleet snapshot. */
    streamed: boolean;
}

const telemetry = new Map<string, Telemetry>();
const M_PER_DEG = 111_320;
/** Never draw a drone further ahead of its last report than this. */
const EXTRAPOLATE_S = 1.2;
/** A snapshot does not override telemetry that arrived this recently. */
const STREAM_WINS_MS = 2500;

export function getTelemetry(droneId: string): Telemetry | undefined {
    return telemetry.get(droneId);
}

export function isAirborne(t: Pick<Telemetry, 'mode' | 'altM'> | undefined): boolean {
    return t !== undefined && (t.mode === 'patrol' || t.mode === 'returning');
}

export const MODE_LABEL: Record<DroneMode, string> = {
    idle: 'Idle',
    patrol: 'Mapping',
    returning: 'Returning',
    landed: 'Landed',
};

/** Where to draw the drone now: its last report moved along its velocity for a moment. */
export function livePosition(
    droneId: string,
    now = performance.now(),
): { lat: number; lon: number; altM: number } | undefined {
    const t = telemetry.get(droneId);
    if (!t) return undefined;
    const dt = Math.min(EXTRAPOLATE_S, Math.max(0, (now - t.receivedAt) / 1000));
    return {
        lat: t.lat + (t.northMps * dt) / M_PER_DEG,
        lon: t.lon + (t.eastMps * dt) / (M_PER_DEG * Math.cos((t.lat * Math.PI) / 180)),
        altM: t.altM,
    };
}

export function fromTelemetry(m: DroneTelemetry): void {
    const before = telemetry.get(m.droneId);
    telemetry.set(m.droneId, {
        lat: m.pose.lat,
        lon: m.pose.lng,
        altM: m.pose.altM,
        headingDeg: m.pose.headingDeg,
        speedMs: Math.hypot(m.velocity.eastMps, m.velocity.northMps),
        batteryPct: m.batteryPct,
        mode: m.mode,
        eastMps: m.velocity.eastMps,
        northMps: m.velocity.northMps,
        receivedAt: performance.now(),
        lastSeenAt: Date.parse(m.sentAt) || Date.now(),
        name: before?.name ?? m.droneId,
        kind: before?.kind ?? 'physical',
        streamed: true,
    });
}

export function fromFleet(drones: DroneSummary[]): void {
    const now = performance.now();
    for (const d of drones) {
        const before = telemetry.get(d.droneId);
        if (before?.streamed && now - before.receivedAt < STREAM_WINS_MS) {
            before.name = d.name;
            before.kind = d.kind;
            continue;
        }
        telemetry.set(d.droneId, {
            lat: d.pose.lat,
            lon: d.pose.lng,
            altM: d.pose.altM,
            headingDeg: d.pose.headingDeg,
            speedMs: before?.speedMs ?? 0,
            batteryPct: d.batteryPct,
            mode: d.mode,
            eastMps: 0,
            northMps: 0,
            receivedAt: now,
            lastSeenAt: Date.parse(d.lastSeen) || Date.now(),
            name: d.name,
            kind: d.kind,
            streamed: false,
        });
    }
}
