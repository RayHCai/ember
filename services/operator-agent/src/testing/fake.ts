import type {
    Blast,
    Civilian,
    CreateBlastRequest,
    PlannerJob,
    PlannerResult,
    RiskZone,
    RiskZonesView,
    WatchZone,
    WatchZoneId,
    ZoneSurroundings,
} from '@ember/contracts';
import type { Api } from '../api.js';
import type { AgentConfig } from '../config.js';

export const ZONE_ID = 'zone-1' as WatchZoneId;
export const T0 = '2026-10-04T10:00:00.000Z';

export const zone: WatchZone = {
    id: ZONE_ID,
    name: 'Lahaina',
    region: 'Maui',
    boundary: [],
    scanEveryHours: null,
    nextScanAt: null,
    createdAt: T0,
    updatedAt: T0,
};

export const config: AgentConfig = {
    apiUrl: 'http://api',
    apiKey: 'ak',
    chatKey: 'ck',
    civilianMapUrl: 'https://map.ember.test',
    tickMs: 10_000,
    planRetryMs: 120_000,
    deliveryLookbackMin: 60,
    responderZones: 3,
};

export function fire(firstSeenAt = T0): RiskZone {
    return {
        id: 'rz-1',
        risk: 'on_fire',
        polygon: [],
        confidence: 0.9,
        observedAt: firstSeenAt,
        bbox: { south: 0, west: 0, north: 0, east: 0 },
        center: { lat: 20.9, lng: -156.65 },
        areaM2: 5000,
        firstSeenAt,
        detections: 3,
        droneIds: ['sim-1'],
    };
}

export const surroundings: ZoneSurroundings = {
    zoneId: ZONE_ID,
    status: 'ready',
    source: 'test',
    fetchedAt: T0,
    error: null,
    civilianAreas: [
        {
            id: 'a-kahana',
            name: 'Kahana',
            center: { lat: 20.97, lng: -156.68 },
            polygon: null,
            population: 1200,
        },
        {
            id: 'a-napili',
            name: 'Napili',
            center: { lat: 21.0, lng: -156.67 },
            polygon: null,
            population: 800,
        },
        {
            id: 'a-front',
            name: 'Front Street',
            center: { lat: 20.87, lng: -156.68 },
            polygon: null,
            population: 3000,
        },
        {
            id: 'a-far',
            name: 'Kapalua',
            center: { lat: 21.0, lng: -156.65 },
            polygon: null,
            population: 400,
        },
    ],
    roads: [
        {
            id: 'r-30',
            name: 'Honoapiilani Hwy',
            kind: 'primary',
            path: [
                { lat: 20.97, lng: -156.68 },
                { lat: 20.99, lng: -156.675 },
            ],
        },
    ],
    safeZones: [
        {
            id: 's-1',
            name: 'Kapalua Airport',
            location: { lat: 21.0, lng: -156.67 },
            capacity: 500,
        },
    ],
    stations: [],
};

export const ZIPS: Record<string, string> = {
    '20.9700,-156.6800': '96761',
    '21.0000,-156.6700': '96761',
    '20.8700,-156.6800': '96767',
};

export const result: PlannerResult = {
    jobId: 'job-1',
    zoneId: ZONE_ID,
    generatedAt: T0,
    contextGeneratedAt: T0,
    horizonMin: 180,
    assumptions: [],
    fireSpread: {
        grid: { southWest: { lat: 20.8, lng: -156.7 }, cellSizeM: 100, cols: 1, rows: 1 },
        arrivalMin: [],
        isochrones: [],
        track: [],
        headingDeg: 0,
        maxSpreadMpm: 12.34,
    },
    attackZones: [2, 1, 3, 4].map((rank) => ({
        id: `az-${rank}`,
        rank,
        center: { lat: 20.9, lng: -156.66 },
        radiusM: 400,
        dropSite: { lat: 20.9 + rank / 100, lng: -156.66 },
        score: 1 / rank,
        fireArrivalMin: 30 * rank,
        accessMin: 12,
        spreadRateMpm: 10,
        tactic: rank === 1 ? 'indirect' : 'direct',
        protects: ['Kahana'],
        protectedPopulation: 1200,
        protectedAreaHa: 50,
    })),
    civilianImpacts: [
        {
            civilianAreaId: 'a-napili',
            name: 'Napili',
            population: 800,
            impactMin: 60,
            gradient: 0.5,
            exposedFraction: 0.3,
            severity: 'warning',
        },
        {
            civilianAreaId: 'a-kahana',
            name: 'Kahana',
            population: 1200,
            impactMin: 25,
            gradient: 0.8,
            exposedFraction: 0.6,
            severity: 'immediate',
        },
        {
            civilianAreaId: 'a-front',
            name: 'Front Street',
            population: 3000,
            impactMin: 40,
            gradient: 0.6,
            exposedFraction: 0.5,
            severity: 'warning',
        },
        {
            civilianAreaId: 'a-far',
            name: 'Kapalua',
            population: 400,
            impactMin: 150,
            gradient: 0.1,
            exposedFraction: 0.1,
            severity: 'watch',
        },
    ],
    evacuationRoutes: [
        {
            civilianAreaId: 'a-kahana',
            status: 'clear',
            path: [
                { lat: 20.97, lng: -156.68 },
                { lat: 20.99, lng: -156.675 },
                { lat: 21.0, lng: -156.67 },
            ],
            destination: { safeZoneId: 's-1', location: { lat: 21.0, lng: -156.67 } },
            distanceM: 4000,
            etaMin: 12,
            clearanceMin: 30,
            network: 'roads',
        },
        {
            civilianAreaId: 'a-front',
            status: 'no_safe_route',
            path: [],
            destination: null,
            distanceM: 0,
            etaMin: 0,
            clearanceMin: null,
            network: 'roads',
        },
    ],
};

/** The api's records in memory, holding the same approval line the real one does. */
export class FakeApi implements Api {
    riskZoneList: RiskZone[] = [];
    jobs: PlannerJob[] = [];
    blastList: Blast[] = [];
    civilians: Civilian[] = [
        { id: 'c-1', phone: '+18085550001', zipCode: '96761', createdAt: T0 },
        { id: 'c-2', phone: '+18085550002', zipCode: '96761', createdAt: T0 },
        { id: 'c-3', phone: '+18085550003', zipCode: '96767', createdAt: T0 },
        { id: 'c-4', phone: '+18085550004', zipCode: '90210', createdAt: T0 },
    ];
    planResult: PlannerResult | null = result;
    private seq = 0;

    constructor(private readonly clock: () => Date) {}

    async zones() {
        return [zone];
    }
    async riskZones(): Promise<RiskZonesView> {
        const at = this.clock().toISOString();
        return { zoneId: ZONE_ID, since: T0, generatedAt: at, riskZones: this.riskZoneList };
    }
    async surroundings() {
        return surroundings;
    }
    async plannerJobs() {
        return [...this.jobs].toReversed();
    }
    async plannerJob(jobId: string) {
        const job = this.jobs.find((j) => j.jobId === jobId)!;
        return { ...job, result: job.state === 'succeeded' ? this.planResult : null };
    }
    async requestPlan(zoneId: string, requestedBy: string) {
        const at = this.clock().toISOString();
        const job: PlannerJob = {
            jobId: `job-${++this.seq}`,
            zoneId: zoneId as WatchZoneId,
            state: 'queued',
            requestedBy,
            requestedAt: at,
            options: null,
            message: null,
            updatedAt: at,
        };
        this.jobs.push(job);
        return job;
    }
    async blasts() {
        return [...this.blastList].toReversed();
    }
    async createBlast(zoneId: string, req: CreateBlastRequest) {
        const blast: Blast = {
            blastId: `blast-${++this.seq}`,
            zoneId: zoneId as WatchZoneId,
            audience: req.audience,
            priority: req.priority,
            area: req.area,
            title: req.title,
            body: req.body,
            state: req.audience === 'responders' ? 'queued' : 'pending_approval',
            createdBy: 'service',
            createdAt: this.clock().toISOString(),
            approval: null,
        };
        this.blastList.push(blast);
        return blast;
    }
    async civiliansIn(zipCode: string) {
        return this.civilians.filter((c) => c.zipCode === zipCode);
    }

    finishPlan(state: 'succeeded' | 'failed' = 'succeeded') {
        const job = this.jobs.at(-1)!;
        job.state = state;
        job.updatedAt = this.clock().toISOString();
    }

    approve(blastId: string, at = this.clock()) {
        const blast = this.blastList.find((b) => b.blastId === blastId)!;
        blast.state = 'queued';
        blast.approval = { approvedBy: 'op-1', approverName: 'Ana', approvedAt: at.toISOString() };
    }
}
