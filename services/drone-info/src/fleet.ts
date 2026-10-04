import type {
    DroneDetections,
    DroneHello,
    DroneSummary,
    DroneTelemetry,
    FleetSnapshot,
} from '@ember/contracts';

export type Reported = DroneHello | DroneTelemetry | DroneDetections;
export type DroneUpdate = DroneTelemetry | DroneDetections;

type Entry = {
    hello: DroneHello | null;
    telemetry: DroneTelemetry | null;
    detections: DroneDetections | null;
    lastSeen: number;
};

/** Latest state of every drone the edges have reported, and a feed of updates as they arrive. */
export class Fleet {
    private readonly drones = new Map<string, Entry>();
    private readonly listeners = new Set<(u: DroneUpdate) => void>();

    constructor(private readonly now: () => number = Date.now) {}

    ingest(m: Reported): void {
        let e = this.drones.get(m.droneId);
        if (!e) {
            e = { hello: null, telemetry: null, detections: null, lastSeen: 0 };
            this.drones.set(m.droneId, e);
        }
        e.lastSeen = this.now();
        if (m.type === 'hello') {
            e.hello = m;
            return;
        }
        if (m.type === 'telemetry') e.telemetry = m;
        else e.detections = m;
        for (const fn of this.listeners) fn(m);
    }

    /** Drones with a known position, by id. */
    snapshot(): FleetSnapshot {
        const drones: DroneSummary[] = [];
        for (const [droneId, e] of [...this.drones].toSorted(([a], [b]) => a.localeCompare(b))) {
            const t = e.telemetry;
            if (!t) continue;
            drones.push({
                droneId,
                name: e.hello?.name ?? droneId,
                kind: e.hello?.kind ?? 'physical',
                mode: t.mode,
                batteryPct: t.batteryPct,
                pose: t.pose,
                lastSeen: new Date(e.lastSeen).toISOString(),
            });
        }
        return { type: 'fleet', drones };
    }

    /** What a viewer that starts following this drone needs before the next update arrives. */
    latest(droneId: string): DroneUpdate[] {
        const e = this.drones.get(droneId);
        if (!e) return [];
        return [e.telemetry, e.detections].filter((m): m is DroneUpdate => m !== null);
    }

    subscribe(fn: (u: DroneUpdate) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}
