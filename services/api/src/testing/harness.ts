import type {
    AttackZone,
    EdgeServerStatus,
    EdgeTask,
    EdgeTaskResult,
    LatLng,
    PlannerResult,
    Weather,
} from '@ember/contracts';
import { buildApp } from '../app.js';
import type { Keys } from '../auth.js';
import type { Deps } from '../deps.js';
import { MemoryPlannerQueue, type EdgeManager } from '../integrations.js';
import { memoryStore } from '../store/index.js';

export class FakeEdge implements EdgeManager {
    readonly tasks: EdgeTask[] = [];
    fail: Error | null = null;

    async send(task: EdgeTask): Promise<EdgeTaskResult> {
        if (this.fail) throw this.fail;
        this.tasks.push(task);
        return {
            runId: task.runId,
            results: task.edgeServers.map((e) => ({
                edgeServerId: e.edgeServerId,
                ok: true as const,
                drones: ['d1'],
            })),
        };
    }

    async servers(): Promise<EdgeServerStatus[]> {
        return [];
    }
}

export const WEATHER: Weather = {
    observedAt: '2023-08-08T15:00:00.000Z',
    windSpeedMps: 17,
    windFromDeg: 70,
    temperatureC: 30,
    relativeHumidityPct: 30,
    windGustMps: 30,
    redFlagWarning: true,
    source: 'test',
};

export function harness(keys: Keys = {}) {
    let clock = new Date('2026-10-03T12:00:00Z');
    const queue = new MemoryPlannerQueue();
    const edge = new FakeEdge();
    const deps: Deps = {
        store: memoryStore(),
        queue,
        edge,
        weather: { current: async () => WEATHER },
        keys,
        config: { publicApiUrl: 'http://api.test', droneInfoUrl: null, scanCellSizeM: 10 },
        now: () => clock,
    };
    const app = buildApp(deps);
    return {
        app,
        deps,
        queue,
        edge,
        advance(ms: number) {
            clock = new Date(clock.getTime() + ms);
        },
    };
}

/** A square ring of side ~2 km around `c`. */
export function square(c: LatLng, halfDeg = 0.01): LatLng[] {
    return [
        { lat: c.lat - halfDeg, lng: c.lng - halfDeg },
        { lat: c.lat - halfDeg, lng: c.lng + halfDeg },
        { lat: c.lat + halfDeg, lng: c.lng + halfDeg },
        { lat: c.lat + halfDeg, lng: c.lng - halfDeg },
    ];
}

export const CENTER = { lat: 20.875, lng: -156.675 };

export function attackZone(rank: number, over: Partial<AttackZone> = {}): AttackZone {
    const dropSite = { lat: CENTER.lat + rank * 0.002, lng: CENTER.lng };
    return {
        id: `attack-${rank}`,
        rank,
        center: dropSite,
        radiusM: 150,
        dropSite,
        score: 1 / rank,
        fireArrivalMin: 20 + rank * 8,
        accessMin: 10,
        spreadRateMpm: 6,
        tactic: 'direct',
        protects: ['area-kahoma'],
        protectedPopulation: 300,
        protectedAreaHa: 40,
        approach: {
            stationId: 'station-1',
            path: [CENTER, dropSite],
            roadIds: ['r-hwy', 'r-ridge'],
            etaMin: 9,
            arrivesFromDeg: 135,
        },
        ...over,
    };
}

export function plannerResult(jobId: string, zoneId: string, over: Partial<PlannerResult> = {}) {
    const result: PlannerResult = {
        jobId,
        zoneId: zoneId as PlannerResult['zoneId'],
        generatedAt: '2026-10-03T12:00:00Z',
        contextGeneratedAt: '2026-10-03T12:00:00Z',
        horizonMin: 180,
        assumptions: ['terrain: none known, so the ground is flat'],
        fireSpread: {
            grid: { southWest: CENTER, cellSizeM: 30, cols: 1, rows: 1 },
            arrivalMin: [0],
            isochrones: [],
            track: [],
            headingDeg: 250,
            maxSpreadMpm: 12,
        },
        attackZones: [attackZone(1), attackZone(2)],
        civilianImpacts: [
            {
                civilianAreaId: 'area-kahoma',
                name: 'Kahoma',
                population: 900,
                impactMin: 42,
                gradient: 0.77,
                exposedFraction: 0.6,
                severity: 'immediate',
            },
        ],
        evacuationRoutes: [],
        sectorRisks: [],
        ...over,
    };
    return result;
}
