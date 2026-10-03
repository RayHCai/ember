import type {
    CameraSpec,
    DroneDetections,
    DroneInfoMessage,
    DronePose,
    DroneSummary,
    DroneTelemetry,
    LatLng,
    RiskDetection,
} from '@ember/contracts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function pose(v: unknown): v is DronePose {
    if (!isObj(v)) return false;
    return [v.lat, v.lng, v.altM, v.headingDeg, v.pitchDeg].every(isNum);
}

function camera(v: unknown): v is CameraSpec {
    return isObj(v) && isNum(v.widthPx) && isNum(v.heightPx) && isNum(v.hfovDeg);
}

const latLng = (v: unknown): v is LatLng => isObj(v) && isNum(v.lat) && isNum(v.lng);

function detection(v: unknown): v is RiskDetection {
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
        isNum(v.areaM2)
    );
}

function summary(v: unknown): v is DroneSummary {
    return (
        isObj(v) &&
        isStr(v.droneId) &&
        isStr(v.name) &&
        (v.kind === 'simulated' || v.kind === 'physical') &&
        pose(v.pose)
    );
}

/**
 * Validates a Drone Info message at the boundary. Anything off-contract is reported and
 * dropped, so one bad message never breaks the view.
 */
export function parseDroneInfoMessage(
    raw: string,
): { message: DroneInfoMessage } | { error: string } {
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return { error: 'not JSON' };
    }
    if (!isObj(v)) return { error: 'not an object' };
    switch (v.type) {
        case 'fleet':
            return Array.isArray(v.drones) && v.drones.every(summary)
                ? { message: v as unknown as DroneInfoMessage }
                : { error: 'fleet: bad drone summary' };
        case 'telemetry':
            if (!isStr(v.droneId) || !pose(v.pose) || !camera(v.camera)) {
                return { error: 'telemetry: bad pose or camera' };
            }
            if (v.scenarioTime !== null && !isStr(v.scenarioTime)) {
                return { error: 'telemetry: bad scenarioTime' };
            }
            return { message: v as DroneTelemetry };
        case 'detections':
            if (!isStr(v.droneId) || !pose(v.pose) || !camera(v.camera) || !isStr(v.scenarioTime)) {
                return { error: 'detections: bad header' };
            }
            if (!Array.isArray(v.detections) || !v.detections.every(detection)) {
                return { error: 'detections: bad detection' };
            }
            return { message: v as DroneDetections };
        default:
            return { error: `unknown message type ${String(v.type)}` };
    }
}
