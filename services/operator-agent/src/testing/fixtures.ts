import type {
    AttackZone,
    CivilianImpact,
    EvacuationRoute,
    PlannerResult,
    WatchZoneId,
} from '@ember/contracts';
import type { AgentConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { LogTransport } from '../channels.js';
import { InMemory } from '../memory.js';
import type { ApiClient } from '../api.js';
import type { Geography } from '../views.js';

export const C = { lat: 20.885, lng: -156.669 };

export const GEO: Geography = {
    roads: [
        { id: 'r-hwy', name: 'Highway 30', kind: 'primary', path: [C, C], state: 'open' },
        { id: 'r-ridge', name: 'Ridge Rd', kind: 'track', path: [C, C], state: 'open' },
        { id: 'r-bypass', name: 'Lahaina Bypass', kind: 'primary', path: [C, C], state: 'open' },
        { id: 'r-front', name: 'Front St', kind: 'secondary', path: [C, C], state: 'open' },
    ],
    civilianAreas: [
        { id: 'area-bypass', name: 'Bypass Homes', center: C, polygon: null, population: 500 },
        { id: 'area-town', name: 'Lahaina Town', center: C, polygon: null, population: 2400 },
    ],
    safeZones: [
        {
            id: 'sz-north',
            name: 'Kaanapali exit',
            location: { lat: 20.9035, lng: -156.6768 },
            capacity: null,
        },
        {
            id: 'sz-south',
            name: 'Puamana Park',
            location: { lat: 20.859, lng: -156.67 },
            capacity: null,
        },
    ],
};

export function zone(rank: number, roadIds: string[], over: Partial<AttackZone> = {}): AttackZone {
    const p = { lat: C.lat + rank * 0.003, lng: C.lng };
    return {
        id: `attack-${rank}`,
        rank,
        center: p,
        radiusM: 150,
        dropSite: p,
        score: 1 / rank,
        fireArrivalMin: 20 * rank,
        accessMin: 9,
        spreadRateMpm: 6,
        tactic: 'direct',
        protects: ['area-bypass'],
        protectedPopulation: 500,
        protectedAreaHa: 30,
        approach: { stationId: 'st-1', path: [C, p], roadIds, etaMin: 9, arrivesFromDeg: 135 },
        ...over,
    };
}

export function impact(
    id: string,
    impactMin: number | null,
    severity: CivilianImpact['severity'],
): CivilianImpact {
    return {
        civilianAreaId: id,
        name: id === 'area-bypass' ? 'Bypass Homes' : 'Lahaina Town',
        population: 500,
        impactMin,
        gradient: 0.5,
        exposedFraction: 0.4,
        severity,
    };
}

export function route(id: string, roadIds: string[], safeZoneId = 'sz-north'): EvacuationRoute {
    const dest = GEO.safeZones.find((z) => z.id === safeZoneId)!;
    return {
        civilianAreaId: id,
        status: 'clear',
        path: [C, dest.location],
        destination: { safeZoneId, location: dest.location },
        distanceM: 2500,
        etaMin: 13,
        clearanceMin: 60,
        roadIds,
        network: 'roads',
        alternate: null,
    };
}

export function result(jobId: string, over: Partial<PlannerResult> = {}): PlannerResult {
    return {
        jobId,
        zoneId: 'z1' as WatchZoneId,
        generatedAt: '2026-10-03T12:00:00Z',
        contextGeneratedAt: '2026-10-03T12:00:00Z',
        horizonMin: 180,
        assumptions: ['elevation: flat ground'],
        fireSpread: {
            grid: { southWest: C, cellSizeM: 30, cols: 1, rows: 1 },
            arrivalMin: [0],
            isochrones: [{ atMin: 30, areaHa: 12, polygons: [] }],
            track: [],
            headingDeg: 250,
            maxSpreadMpm: 8.6,
        },
        attackZones: [zone(1, ['r-bypass']), zone(2, ['r-hwy', 'r-ridge'])],
        civilianImpacts: [
            impact('area-bypass', 108, 'warning'),
            impact('area-town', null, 'clear'),
        ],
        evacuationRoutes: [route('area-bypass', ['r-bypass', 'r-hwy'])],
        sectorRisks: [],
        ...over,
    };
}

export const CONFIG: AgentConfig = {
    apiUrl: 'http://api.test',
    civilianMapUrl: 'http://map.test',
    signupUrl: null,
    operatorAddresses: ['agent1qoperator'],
    tickMs: 1000,
    plannerWaitMs: 5000,
    confirmConfidence: 0.85,
    verifyConfidence: 0.35,
    corroborateM: 500,
    riskPlanMaxAgeMin: 30,
};

const quiet = { info() {}, warn() {}, error() {} };

/** A context over a partial api fake; calls to anything the fake lacks fail the test loudly. */
export function context(api: Partial<ApiClient>, over: Partial<Ctx> = {}): Ctx {
    let t = Date.parse('2026-10-03T12:00:00Z');
    const proxy = new Proxy(api, {
        get(target, prop) {
            const v = (target as Record<string | symbol, unknown>)[prop];
            if (v === undefined) throw new Error(`fake api has no ${String(prop)}`);
            return v;
        },
    }) as ApiClient;
    return {
        api: proxy,
        memory: new InMemory(),
        reasoner: null,
        imager: null,
        transport: new LogTransport(),
        config: CONFIG,
        log: quiet,
        geocode: async () => null,
        now: () => new Date(t),
        sleep: async (ms) => {
            t += ms;
        },
        ...over,
    };
}
