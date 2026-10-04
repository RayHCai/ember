import type {
    Approval,
    AssignRespondersRequest,
    AssignRespondersResult,
    Civilian,
    CivilianMessage,
    CreateApprovalRequest,
    CreateFieldReportRequest,
    CreateIncidentEventRequest,
    CreateIncidentRequest,
    CreateWatchZoneRequest,
    DetectionRecord,
    DetectionVerification,
    EdgeServerRecord,
    EnqueuePlannerJobRequest,
    FieldReport,
    Incident,
    IncidentEvent,
    IncidentView,
    InboundCivilianMessageRequest,
    InboundCivilianMessageResult,
    PlannerJob,
    PlannerJobView,
    QueueCivilianMessageRequest,
    Responder,
    ResponderAssignment,
    ResponderMessage,
    RiskZoneRecord,
    Road,
    RoadObservation,
    RoadObservationRequest,
    Scan,
    SendResponderMessageRequest,
    SimulatedDetectionRequest,
    StartScanRequest,
    SurveillancePlan,
    UpdateIncidentRequest,
    UpdateResponderRequest,
    WatchZone,
    ZoneGeography,
    ZoneWeather,
} from '@ember/contracts';

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly route: string,
        readonly body: { error?: string; candidates?: { id: string; name: string | null }[] },
    ) {
        super(`api ${route}: ${status} ${body.error ?? ''}`.trim());
    }
}

type Query = Record<string, string | undefined>;

/** operator-agent's only way into Ember: the api routes the dashboard uses. */
export class ApiClient {
    constructor(
        private readonly baseUrl: string,
        private readonly key: string | undefined,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    private async call<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
        const qs = query
            ? new URLSearchParams(
                  Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined),
              ).toString()
            : '';
        const route = `${method} ${path}`;
        const res = await this.fetchImpl(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
            method,
            headers: {
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        const parsed: unknown = text ? JSON.parse(text) : null;
        if (!res.ok) throw new ApiError(res.status, route, (parsed ?? {}) as ApiError['body']);
        return parsed as T;
    }

    zones = () => this.call<WatchZone[]>('GET', '/v1/watch-zones');
    zone = (zoneId: string) => this.call<WatchZone>('GET', `/v1/watch-zones/${zoneId}`);
    createZone = (body: CreateWatchZoneRequest) =>
        this.call<WatchZone>('POST', '/v1/watch-zones', body);
    geography = (zoneId: string) =>
        this.call<ZoneGeography & { roads: Road[] }>('GET', `/v1/watch-zones/${zoneId}/geography`);
    weather = (zoneId: string) =>
        this.call<ZoneWeather>('GET', `/v1/watch-zones/${zoneId}/weather`);
    setSurveillance = (zoneId: string, body: Omit<SurveillancePlan, 'setAt'>) =>
        this.call<SurveillancePlan>('PUT', `/v1/watch-zones/${zoneId}/surveillance`, body);
    roads = (zoneId: string) => this.call<Road[]>('GET', `/v1/watch-zones/${zoneId}/roads`);
    observeRoad = (zoneId: string, body: RoadObservationRequest) =>
        this.call<RoadObservation[]>('POST', `/v1/watch-zones/${zoneId}/road-observations`, body);
    roadObservations = (zoneId: string) =>
        this.call<RoadObservation[]>('GET', `/v1/watch-zones/${zoneId}/road-observations`);
    deleteRiskZone = (zoneId: string, riskZoneId: string) =>
        this.call<null>('DELETE', `/v1/watch-zones/${zoneId}/risk-zones/${riskZoneId}`);
    riskZones = (zoneId: string) =>
        this.call<RiskZoneRecord[]>('GET', `/v1/watch-zones/${zoneId}/risk-zones`);

    detections = (
        zoneId: string,
        query: { since?: string; verification?: DetectionVerification } = {},
    ) =>
        this.call<DetectionRecord[]>(
            'GET',
            `/v1/watch-zones/${zoneId}/detections`,
            undefined,
            query,
        );
    detection = (id: string) =>
        this.call<DetectionRecord>('GET', `/v1/detections/${encodeURIComponent(id)}`);
    simulateDetection = (zoneId: string, body: SimulatedDetectionRequest) =>
        this.call<DetectionRecord>('POST', `/v1/watch-zones/${zoneId}/detections/simulated`, body);
    verifyDetection = (id: string, verification: DetectionVerification, by: string) =>
        this.call<DetectionRecord>('PATCH', `/v1/detections/${encodeURIComponent(id)}`, {
            verification,
            by,
        });

    edgeServers = (zoneId: string) =>
        this.call<EdgeServerRecord[]>('GET', `/v1/watch-zones/${zoneId}/edge-servers`);
    scans = (zoneId: string) => this.call<Scan[]>('GET', `/v1/watch-zones/${zoneId}/scans`);
    startScan = (zoneId: string, body: StartScanRequest) =>
        this.call<Scan>('POST', `/v1/watch-zones/${zoneId}/scans`, body);
    stopScan = (runId: string, requestedBy: string, reason: string) =>
        this.call<Scan>('POST', `/v1/scans/${runId}/stop`, { requestedBy, reason });

    enqueuePlan = (zoneId: string, body: EnqueuePlannerJobRequest) =>
        this.call<PlannerJob>('POST', `/v1/watch-zones/${zoneId}/planner-jobs`, body);
    plannerJobs = (zoneId: string) =>
        this.call<PlannerJob[]>('GET', `/v1/watch-zones/${zoneId}/planner-jobs`);
    plan = (jobId: string) => this.call<PlannerJobView>('GET', `/v1/planner/jobs/${jobId}`);
    latestPlan = async (zoneId: string): Promise<PlannerJobView | null> => {
        try {
            return await this.call<PlannerJobView>(
                'GET',
                `/v1/watch-zones/${zoneId}/planner-jobs/latest`,
            );
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) return null;
            throw err;
        }
    };

    incidents = (zoneId: string) =>
        this.call<Incident[]>('GET', `/v1/watch-zones/${zoneId}/incidents`);
    incident = (id: string) => this.call<IncidentView>('GET', `/v1/incidents/${id}`);
    createIncident = (zoneId: string, body: CreateIncidentRequest) =>
        this.call<Incident>('POST', `/v1/watch-zones/${zoneId}/incidents`, body);
    updateIncident = (id: string, body: UpdateIncidentRequest) =>
        this.call<Incident>('PATCH', `/v1/incidents/${id}`, body);
    addIncidentEvent = (id: string, body: CreateIncidentEventRequest) =>
        this.call<IncidentEvent>('POST', `/v1/incidents/${id}/events`, body);

    approvals = (query: { state?: Approval['state']; zoneId?: string } = {}) =>
        this.call<Approval[]>('GET', '/v1/approvals', undefined, query);
    approval = (id: string) => this.call<Approval>('GET', `/v1/approvals/${id}`);
    createApproval = (body: CreateApprovalRequest) =>
        this.call<Approval>('POST', '/v1/approvals', body);

    reports = (zoneId: string, unprocessed = false) =>
        this.call<FieldReport[]>('GET', `/v1/watch-zones/${zoneId}/reports`, undefined, {
            unprocessed: unprocessed ? 'true' : undefined,
        });
    createReport = (zoneId: string, body: CreateFieldReportRequest) =>
        this.call<FieldReport>('POST', `/v1/watch-zones/${zoneId}/reports`, body);
    processReport = (id: string, note: string) =>
        this.call<FieldReport>('PATCH', `/v1/reports/${id}`, { note });

    civilians = (zoneId: string) =>
        this.call<Civilian[]>('GET', `/v1/watch-zones/${zoneId}/civilians`);
    civilian = (id: string) => this.call<Civilian>('GET', `/v1/civilians/${id}`);
    civilianMessages = (query: {
        civilianId?: string;
        direction?: 'inbound' | 'outbound';
        status?: CivilianMessage['status'];
        since?: string;
    }) => this.call<CivilianMessage[]>('GET', '/v1/civilian-messages', undefined, query);
    recordInbound = (body: InboundCivilianMessageRequest) =>
        this.call<InboundCivilianMessageResult>('POST', '/v1/civilian-messages/inbound', body);
    queueCivilianMessage = (body: QueueCivilianMessageRequest) =>
        this.call<CivilianMessage>('POST', '/v1/civilian-messages', body);
    reportDelivery = (id: string, status: 'sent' | 'failed', error?: string) =>
        this.call<CivilianMessage>('PATCH', `/v1/civilian-messages/${id}`, { status, error });

    responders = (zoneId: string) =>
        this.call<Responder[]>('GET', `/v1/watch-zones/${zoneId}/responders`);
    updateResponder = (id: string, body: UpdateResponderRequest) =>
        this.call<Responder>('PATCH', `/v1/responders/${id}`, body);
    assignments = (
        zoneId: string,
        query: { state?: ResponderAssignment['state']; incidentId?: string } = {},
    ) =>
        this.call<ResponderAssignment[]>(
            'GET',
            `/v1/watch-zones/${zoneId}/assignments`,
            undefined,
            query,
        );
    assign = (zoneId: string, body: AssignRespondersRequest) =>
        this.call<AssignRespondersResult>('POST', `/v1/watch-zones/${zoneId}/assignments`, body);
    sendResponderMessage = (zoneId: string, body: SendResponderMessageRequest) =>
        this.call<ResponderMessage>('POST', `/v1/watch-zones/${zoneId}/responder-messages`, body);
}

/** The approval decision is a separate client: it carries the operator key, never the agent's. */
export class OperatorRelay {
    constructor(
        private readonly baseUrl: string,
        private readonly operatorKey: string | undefined,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    get enabled() {
        return !!this.operatorKey;
    }

    async decide(
        approvalId: string,
        body: { decision: 'approve' | 'reject'; operator: string; confirmationCode: string },
    ): Promise<Approval> {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/approvals/${approvalId}/decision`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.operatorKey ?? ''}`,
            },
            body: JSON.stringify({ ...body, via: 'asi1' }),
            signal: AbortSignal.timeout(15_000),
        });
        const parsed = (await res.json()) as Approval & { error?: string };
        if (!res.ok) throw new ApiError(res.status, 'POST /v1/approvals/:id/decision', parsed);
        return parsed;
    }
}
