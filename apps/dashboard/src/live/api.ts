import type {
    Approval,
    ApprovalDecisionRequest,
    DetectionRecord,
    EdgeServerRecord,
    Incident,
    PlannerJob,
    PlannerJobView,
    Responder,
    ResponderAssignment,
    RiskZoneRecord,
    RoadObservationRequest,
    SimulatedDetectionRequest,
    WatchZone,
    ZoneGeography,
} from '@ember/contracts';

// The Ember api through the dev server's /ember-api proxy, which adds the operator key.

const BASE = '/ember-api';

export class LiveApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'LiveApiError';
    }
}

function errorText(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === 'string') return message;
    return typeof error === 'string' ? error : null;
}

/** GET without a body, POST with one. */
async function call(path: string, body?: unknown): Promise<unknown> {
    const method = body === undefined ? 'GET' : 'POST';
    let res: Response;
    try {
        res = await fetch(
            `${BASE}${path}`,
            body === undefined
                ? { method }
                : {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(body),
                  },
        );
    } catch (e) {
        throw new LiveApiError(
            0,
            `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    // Without the proxy the request falls through to the app shell, which is not JSON.
    if (!(res.headers.get('content-type') ?? '').includes('application/json'))
        throw new LiveApiError(res.status, `${method} ${path}: no Ember api behind ${BASE}`);
    const data: unknown = await res.json();
    if (!res.ok)
        throw new LiveApiError(
            res.status,
            `${method} ${path}: ${errorText(data) ?? `HTTP ${res.status}`}`,
        );
    return data;
}

function list<T>(path: string): Promise<T[]> {
    return call(path).then((data) => {
        if (!Array.isArray(data)) throw new LiveApiError(200, `GET ${path}: expected a list`);
        return data as T[];
    });
}

function one<T>(path: string): Promise<T> {
    return call(path).then((data) => {
        if (typeof data !== 'object' || data === null || Array.isArray(data))
            throw new LiveApiError(200, `GET ${path}: expected an object`);
        return data as T;
    });
}

const zone = (zoneId: string, rest: string) =>
    `/v1/watch-zones/${encodeURIComponent(zoneId)}${rest}`;

export const getWatchZones = () => list<WatchZone>('/v1/watch-zones');
export const getGeography = (zoneId: string) => one<ZoneGeography>(zone(zoneId, '/geography'));
export const getEdgeServers = (zoneId: string) =>
    list<EdgeServerRecord>(zone(zoneId, '/edge-servers'));
export const getDetections = (zoneId: string) => list<DetectionRecord>(zone(zoneId, '/detections'));
export const getRiskZones = (zoneId: string) => list<RiskZoneRecord>(zone(zoneId, '/risk-zones'));
export const getIncidents = (zoneId: string) => list<Incident>(zone(zoneId, '/incidents'));
export const getResponders = (zoneId: string) => list<Responder>(zone(zoneId, '/responders'));
export const getActiveAssignments = (zoneId: string) =>
    list<ResponderAssignment>(zone(zoneId, '/assignments?state=active'));
export const getPlannerJobs = (zoneId: string) => list<PlannerJob>(zone(zoneId, '/planner-jobs'));
export const getPlannerJob = (jobId: string) =>
    one<PlannerJobView>(`/v1/planner/jobs/${encodeURIComponent(jobId)}`);
export const getPendingApprovals = (zoneId: string) =>
    list<Approval>(`/v1/approvals?state=pending&zoneId=${encodeURIComponent(zoneId)}`);

export const postDecision = (approvalId: string, body: ApprovalDecisionRequest) =>
    call(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, body);
export const postSimulatedDetection = (zoneId: string, body: SimulatedDetectionRequest) =>
    call(zone(zoneId, '/detections/simulated'), body);
export const postRoadObservation = (zoneId: string, body: RoadObservationRequest) =>
    call(zone(zoneId, '/road-observations'), body);
