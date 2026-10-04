import type { Reported } from './fleet.js';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const latLng = (v: unknown) => isObj(v) && isNum(v.lat) && isNum(v.lng);
const pose = (v: unknown) =>
    isObj(v) && [v.lat, v.lng, v.altM, v.headingDeg, v.pitchDeg].every(isNum);
const camera = (v: unknown) =>
    isObj(v) && isNum(v.widthPx) && isNum(v.heightPx) && isNum(v.hfovDeg);
const KINDS = new Set(['simulated', 'physical']);
const MODES = new Set(['idle', 'patrol', 'returning', 'landed']);

function detection(v: unknown): boolean {
    return (
        isObj(v) &&
        isStr(v.id) &&
        (v.risk === 'at_risk' || v.risk === 'on_fire') &&
        isNum(v.confidence) &&
        Array.isArray(v.bboxPx) &&
        v.bboxPx.length === 4 &&
        v.bboxPx.every(isNum) &&
        Array.isArray(v.ground) &&
        v.ground.every(latLng) &&
        latLng(v.center) &&
        isNum(v.areaM2) &&
        (v.peakTempK === undefined || isNum(v.peakTempK))
    );
}

/** One forwarded drone message checked against droneLink.ts / droneInfo.ts. */
export function parseReported(v: unknown): { message: Reported } | { error: string } {
    if (!isObj(v)) return { error: 'not an object' };
    if (!isStr(v.droneId)) return { error: `${String(v.type)}: missing droneId` };
    const who = `${String(v.type)} from ${v.droneId}`;
    switch (v.type) {
        case 'hello':
            return isStr(v.name) &&
                KINDS.has(v.kind as string) &&
                camera(v.camera) &&
                Array.isArray(v.sensors) &&
                isNum(v.maxSpeedMps) &&
                isNum(v.enduranceS)
                ? { message: v as unknown as Reported }
                : { error: `${who}: bad name, kind, camera, sensors or limits` };
        case 'telemetry':
            return isStr(v.sentAt) &&
                (v.scenarioTime === null || isStr(v.scenarioTime)) &&
                isNum(v.scenarioSpeed) &&
                pose(v.pose) &&
                camera(v.camera) &&
                isObj(v.velocity) &&
                [v.velocity.eastMps, v.velocity.northMps, v.velocity.upMps].every(isNum) &&
                isNum(v.batteryPct) &&
                MODES.has(v.mode as string)
                ? { message: v as unknown as Reported }
                : { error: `${who}: bad pose, camera, velocity, battery, mode or clock` };
        case 'detections':
            if (
                !isNum(v.frameId) ||
                !isStr(v.capturedAt) ||
                !isStr(v.scenarioTime) ||
                !pose(v.pose) ||
                !camera(v.camera) ||
                !isStr(v.detector)
            )
                return { error: `${who}: bad header` };
            return Array.isArray(v.detections) && v.detections.every(detection)
                ? { message: v as unknown as Reported }
                : { error: `${who}: bad detection` };
        default:
            return { error: `unknown message type ${String(v.type)}` };
    }
}
