import type { DroneTelemetry } from './types';

// Drone telemetry changes every frame. It lives here, outside React and the store:
// map layers read it each frame, panels poll it a few times a second.

const telemetry = new Map<string, DroneTelemetry>();

export function getTelemetry(droneId: string): DroneTelemetry | undefined {
    return telemetry.get(droneId);
}

export function setTelemetry(droneId: string, t: DroneTelemetry): void {
    telemetry.set(droneId, t);
}

export function patchTelemetry(droneId: string, patch: Partial<DroneTelemetry>): void {
    const t = telemetry.get(droneId);
    if (t) Object.assign(t, patch);
}

export function dropTelemetry(droneId: string): void {
    telemetry.delete(droneId);
}
