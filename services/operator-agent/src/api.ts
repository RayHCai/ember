import {
    CIVILIANS_PATH,
    PLANNER_JOBS_PATH,
    WATCH_ZONES_PATH,
    type Blast,
    type Civilian,
    type CreateBlastRequest,
    type PlannerJob,
    type PlannerOptions,
    type RiskZonesView,
    type WatchZone,
    type ZoneSurroundings,
} from '@ember/contracts';

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/** What the agent needs from the api; `HttpApi` is the real one, tests pass a fake. */
export interface Api {
    zones(): Promise<WatchZone[]>;
    riskZones(zoneId: string): Promise<RiskZonesView>;
    surroundings(zoneId: string): Promise<ZoneSurroundings>;
    plannerJobs(zoneId: string): Promise<PlannerJob[]>;
    plannerJob(jobId: string): Promise<PlannerJob>;
    requestPlan(zoneId: string, requestedBy: string, options?: PlannerOptions): Promise<PlannerJob>;
    blasts(zoneId: string): Promise<Blast[]>;
    createBlast(zoneId: string, blast: CreateBlastRequest): Promise<Blast>;
    civiliansIn(zipCode: string): Promise<Civilian[]>;
}

/** The api over HTTP, on the same routes the dashboard uses. */
export class HttpApi implements Api {
    constructor(
        private readonly baseUrl: string,
        private readonly key: string | undefined,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {};
        if (this.key) headers.authorization = `Bearer ${this.key}`;
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const err = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new ApiError(res.status, `${method} ${path}: ${res.status} ${err?.error ?? ''}`);
        }
        return (await res.json()) as T;
    }

    private zone = (zoneId: string, rest: string) =>
        `${WATCH_ZONES_PATH}/${encodeURIComponent(zoneId)}${rest}`;

    zones() {
        return this.call<WatchZone[]>('GET', WATCH_ZONES_PATH);
    }
    riskZones(zoneId: string) {
        return this.call<RiskZonesView>('GET', this.zone(zoneId, '/risk-zones'));
    }
    surroundings(zoneId: string) {
        return this.call<ZoneSurroundings>('GET', this.zone(zoneId, '/surroundings'));
    }
    plannerJobs(zoneId: string) {
        return this.call<PlannerJob[]>('GET', this.zone(zoneId, '/planner-jobs?limit=20'));
    }
    plannerJob(jobId: string) {
        return this.call<PlannerJob>('GET', `${PLANNER_JOBS_PATH}/${encodeURIComponent(jobId)}`);
    }
    requestPlan(zoneId: string, requestedBy: string, options?: PlannerOptions) {
        return this.call<PlannerJob>('POST', this.zone(zoneId, '/planner-jobs'), {
            requestedBy,
            ...(options && { options }),
        });
    }
    blasts(zoneId: string) {
        return this.call<Blast[]>('GET', this.zone(zoneId, '/blasts?limit=200'));
    }
    createBlast(zoneId: string, blast: CreateBlastRequest) {
        return this.call<Blast>('POST', this.zone(zoneId, '/blasts'), blast);
    }
    civiliansIn(zipCode: string) {
        return this.call<Civilian[]>(
            'GET',
            `${CIVILIANS_PATH}?${new URLSearchParams({ zipCode })}`,
        );
    }
}
