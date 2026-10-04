import type { DroneInfoMessage } from '@ember/contracts';

export type SourceStatus = {
    status: 'connecting' | 'open' | 'reconnecting';
    /** Where drone data comes from, for the header: a Drone Info URL or the dummy feed. */
    label: string;
    detail: string | null;
};

/**
 * Where the sim gets drones from. The sim never moves drones or detects anything itself: it
 * renders what this source reports. `DroneInfoClient` is the real source (services/drone-info);
 * `DummyDroneInfo` stands in when none is configured.
 */
export interface DroneInfoSource {
    start(): void;
    stop(): void;
    /** Stream telemetry and detections for one drone (null: none). */
    follow(droneId: string | null): void;
    readonly status: SourceStatus;
    onMessage(fn: (m: DroneInfoMessage) => void): () => void;
    onStatus(fn: (s: SourceStatus) => void): () => void;
}

/** Listener bookkeeping shared by sources. */
export class Emitter {
    private readonly messages = new Set<(m: DroneInfoMessage) => void>();
    private readonly statuses = new Set<(s: SourceStatus) => void>();

    constructor(public status: SourceStatus) {}

    onMessage(fn: (m: DroneInfoMessage) => void): () => void {
        this.messages.add(fn);
        return () => this.messages.delete(fn);
    }

    onStatus(fn: (s: SourceStatus) => void): () => void {
        this.statuses.add(fn);
        return () => this.statuses.delete(fn);
    }

    message(m: DroneInfoMessage): void {
        for (const fn of this.messages) fn(m);
    }

    setStatus(s: SourceStatus): void {
        this.status = s;
        for (const fn of this.statuses) fn(s);
    }
}
