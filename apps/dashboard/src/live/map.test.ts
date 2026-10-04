import type {
    Approval,
    DetectionRecord,
    EdgeServerRecord,
    Incident,
    PlannerJob,
    PlannerResult,
    ResponderAssignment,
    RiskZoneRecord,
    WatchZone as ApiWatchZone,
    WatchZoneId,
    ZoneGeography,
} from '@ember/contracts';
import { describe, expect, it } from 'vitest';
import { cellAt, circle, offset } from '../sim/geo';
import { setupStep, zoneStatus } from '../sim/world';
import {
    activeHazards,
    edgeServers,
    isLiveZoneId,
    livePlans,
    liveZone,
    openIncident,
    pendingAlerts,
    planJobId,
    riskMap,
    spreadForecast,
    type LiveHazard,
} from './map';

const ZONE = 'zone-1' as WatchZoneId;
const CENTER = { lat: 20.88, lng: -156.67 };
const AT = '2026-10-04T04:00:00.000Z';

function ring(center: { lat: number; lng: number }, radiusM: number) {
    return circle([center.lat, center.lng], radiusM, 16).map(([lat, lng]) => ({ lat, lng }));
}

const apiZone: ApiWatchZone = {
    id: ZONE,
    name: 'Lahaina',
    boundary: ring(CENTER, 2000),
    center: CENTER,
    areaHa: 1256,
    surveillance: null,
    createdAt: AT,
    updatedAt: AT,
};

function server(id: string, live: EdgeServerRecord['live']): EdgeServerRecord {
    return {
        edgeServerId: id,
        url: `http://${id}.local`,
        name: `${id} edge`,
        zoneId: ZONE,
        location: CENTER,
        connectivityRadiusM: 1200,
        live,
    };
}

function incident(patch: Partial<Incident>): Incident {
    return {
        id: 'inc-1',
        number: 1,
        zoneId: ZONE,
        state: 'active',
        domain: 'emergency',
        title: 'Simulated fire',
        summary: '',
        location: null,
        detectionIds: [],
        latestJobId: null,
        previousJobId: null,
        openedAt: AT,
        updatedAt: AT,
        ...patch,
    };
}

function detection(id: string, patch: Partial<DetectionRecord> = {}): DetectionRecord {
    const center = { lat: CENTER.lat + 0.005, lng: CENTER.lng };
    return {
        id,
        risk: 'on_fire',
        confidence: 0.9,
        bboxPx: [0, 0, 0, 0],
        ground: ring(center, 250),
        center,
        areaM2: 196_000,
        droneId: 'simulation',
        capturedAt: AT,
        zoneId: ZONE,
        source: 'simulated',
        receivedAt: AT,
        verification: 'unverified',
        ...patch,
    };
}

describe('liveZone', () => {
    it('is a set-up live zone with the api boundary and a dashboard id of its own', () => {
        const zone = liveZone(apiZone, 1000);
        expect(zone.id).toBe('live-zone-1');
        expect(isLiveZoneId(zone.id)).toBe(true);
        expect(zone.name).toBe('Lahaina · Live');
        expect(zone.live).toBe(true);
        expect(zone.boundary[0]).toEqual([apiZone.boundary[0]!.lat, apiZone.boundary[0]!.lng]);
        expect(zone.grid.inZoneCount).toBeGreaterThan(0);
        expect(zone.hazards).toEqual([]);
        expect(setupStep(zone)).toBeNull();
        expect(zoneStatus(zone)).toBe('healthy');
    });
});

describe('edgeServers', () => {
    it('maps every record to a deployed server and keeps the live status when there is one', () => {
        const [a, b] = edgeServers([
            server('edge-1', null),
            server('edge-2', {
                edgeServerId: 'edge-2',
                url: 'http://edge-2.local',
                online: true,
                connectedAt: AT,
                lastSeen: AT,
                drones: 3,
                connectedDrones: 2,
                run: null,
            }),
        ]);
        expect(a).toMatchObject({ id: 'edge-1', status: 'deployed', radiusM: 1200, live: null });
        expect(a!.lat).toBe(CENTER.lat);
        expect(a!.lon).toBe(CENTER.lng);
        expect(b!.live).toEqual({
            online: true,
            drones: 3,
            connectedDrones: 2,
            lastSeenAt: Date.parse(AT),
        });
    });
});

describe('activeHazards', () => {
    it('drops dismissed detections and those of closed incidents', () => {
        const hazards = activeHazards(
            [
                detection('d-open'),
                detection('d-dismissed', { verification: 'dismissed' }),
                detection('d-closed'),
            ],
            [],
            [incident({ state: 'closed', detectionIds: ['d-closed'] })],
        );
        expect(hazards).toHaveLength(1);
        expect(hazards[0]!.risk).toBe('on_fire');
    });

    it('keeps risk zones unless every detection behind them is closed', () => {
        const zone = (id: string, detectionIds: string[]): RiskZoneRecord => ({
            id,
            risk: 'at_risk',
            polygon: ring(CENTER, 300),
            confidence: 0.8,
            observedAt: AT,
            zoneId: ZONE,
            source: 'detection',
            detectionIds,
        });
        const hazards = activeHazards(
            [],
            [zone('r-closed', ['d-1']), zone('r-mixed', ['d-1', 'd-2']), zone('r-manual', [])],
            [incident({ state: 'closed', detectionIds: ['d-1'] })],
        );
        expect(hazards).toHaveLength(2);
        expect(hazards.every((h) => h.risk === 'at_risk')).toBe(true);
    });
});

describe('riskMap', () => {
    it('marks watched ground, at-risk ground and fire, fire winning where they overlap', () => {
        const zone = liveZone(apiZone, 0);
        const servers = edgeServers([server('edge-1', null)]);
        const fireAt = offset([CENTER.lat, CENTER.lng], 300, 0);
        const toLatLon = (p: { lat: number; lng: number }): [number, number] => [p.lat, p.lng];
        const hazards: LiveHazard[] = [
            {
                risk: 'at_risk',
                polygon: ring(CENTER, 600).map(toLatLon),
                center: [CENTER.lat, CENTER.lng],
            },
            {
                risk: 'on_fire',
                polygon: ring({ lat: fireAt[0], lng: fireAt[1] }, 200).map(toLatLon),
                center: fireAt,
            },
        ];
        const risk = riskMap(zone.grid, hazards, servers);
        expect(risk[cellAt(zone.grid, fireAt)!]).toBe(3);
        expect(risk[cellAt(zone.grid, offset([CENTER.lat, CENTER.lng], -400, 0))!]).toBe(2);
        expect(risk[cellAt(zone.grid, offset([CENTER.lat, CENTER.lng], 0, 1000))!]).toBe(1);
        expect(risk[cellAt(zone.grid, offset([CENTER.lat, CENTER.lng], 0, 1800))!]).toBe(0);
    });

    it('marks the centre cell of a fire smaller than a cell', () => {
        const zone = liveZone(apiZone, 0);
        const at = offset([CENTER.lat, CENTER.lng], 120, 120);
        const risk = riskMap(zone.grid, [{ risk: 'on_fire', polygon: [], center: at }], []);
        expect(risk[cellAt(zone.grid, at)!]).toBe(3);
        expect(risk.filter((r) => r === 3)).toHaveLength(1);
    });
});

const fireSpread: PlannerResult['fireSpread'] = {
    grid: { southWest: { lat: 20.87, lng: -156.68 }, cellSizeM: 100, cols: 3, rows: 2 },
    arrivalMin: [-2.4, 30.4, null, 60, null, 179.6],
    isochrones: [
        {
            atMin: 30,
            areaHa: 2,
            polygons: [{ outer: ring({ lat: 20.871, lng: -156.679 }, 100), holes: [] }],
        },
    ],
    track: [
        { atMin: 0, center: { lat: 20.8705, lng: -156.6795 }, areaHa: 1 },
        { atMin: 30, center: { lat: 20.871, lng: -156.679 }, areaHa: 4 },
    ],
    headingDeg: 250,
    maxSpreadMpm: 5,
};

describe('spreadForecast', () => {
    it('turns the arrival raster into cell centres, skipping cells the fire never reaches', () => {
        const spread = spreadForecast(fireSpread, 180);
        expect(spread.cells.map((c) => c[2])).toEqual([0, 30, 60, 180]);
        const [lat0, lng0] = spread.cells[0]!;
        expect(lat0).toBeCloseTo(20.87 + 50 / 111_320, 7);
        expect(lng0).toBeGreaterThan(-156.68);
        // Row 1, column 0: one cell north of the first.
        expect(spread.cells[2]![0]).toBeCloseTo(lat0 + 100 / 111_320, 7);
        expect(spread.cells[2]![1]).toBeCloseTo(lng0, 9);
        expect(spread.cellM).toBe(100);
        expect(spread.horizonMin).toBe(180);
    });

    it('draws the track as circles of the burnt area and keeps the isochrone outlines', () => {
        const spread = spreadForecast(fireSpread, 180);
        expect(spread.origin).toEqual([20.8705, -156.6795]);
        expect(spread.headingDeg).toBe(250);
        expect(spread.track[1]!.radiusM).toBeCloseTo(Math.sqrt(40_000 / Math.PI), 6);
        expect(spread.isochrones).toHaveLength(1);
        expect(spread.isochrones![0]!.rings[0]!.length).toBe(17);
    });
});

const geography: ZoneGeography = {
    terrain: null,
    roads: [
        {
            id: 'r-bypass',
            name: 'Lahaina Bypass',
            kind: 'primary',
            path: [CENTER, { lat: 20.89, lng: -156.67 }],
        },
        { id: 'r-hwy', name: 'Highway 30', kind: 'primary', path: [], state: 'blocked' },
    ],
    civilianAreas: [
        {
            id: 'area-town',
            name: 'Lahaina Town',
            center: { lat: 20.872, lng: -156.679 },
            polygon: null,
            population: 2400,
        },
        {
            id: 'area-bypass',
            name: 'Bypass Homes',
            center: { lat: 20.886, lng: -156.668 },
            polygon: null,
            population: 140,
        },
    ],
    safeZones: [
        {
            id: 'sz-exit',
            name: 'North exit',
            location: { lat: 20.9, lng: -156.68 },
            capacity: null,
        },
    ],
    stations: [],
};

function evacuation(
    civilianAreaId: string,
    status: 'clear' | 'no_safe_route',
): PlannerResult['evacuationRoutes'][number] {
    const path = status === 'clear' ? [CENTER, { lat: 20.9, lng: -156.68 }] : [];
    return {
        civilianAreaId,
        status,
        path,
        destination:
            status === 'clear'
                ? { safeZoneId: 'sz-exit', location: { lat: 20.9, lng: -156.68 } }
                : null,
        distanceM: 2463.8,
        etaMin: 13.3,
        clearanceMin: 118,
        roadIds: status === 'clear' ? ['r-bypass', 'r-hwy'] : [],
        network: 'roads',
        alternate:
            status === 'clear'
                ? {
                      status: 'tight',
                      path: [CENTER, { lat: 20.86, lng: -156.67 }],
                      destination: null,
                      distanceM: 3000,
                      etaMin: 16,
                      clearanceMin: 20,
                      roadIds: [],
                  }
                : null,
    };
}

function attack(id: string, rank: number): PlannerResult['attackZones'][number] {
    return {
        id,
        rank,
        center: { lat: 20.8877, lng: -156.666 },
        radiusM: 75.4,
        dropSite: { lat: 20.8868, lng: -156.6694 },
        score: 1,
        fireArrivalMin: 89.7,
        accessMin: 9.5,
        spreadRateMpm: 4.3,
        tactic: rank === 1 ? 'direct' : 'indirect',
        protects: [],
        protectedPopulation: 0,
        protectedAreaHa: 0,
        approach: null,
    };
}

const result: PlannerResult = {
    jobId: 'job-2',
    zoneId: ZONE,
    generatedAt: AT,
    contextGeneratedAt: AT,
    horizonMin: 180,
    assumptions: [],
    fireSpread,
    attackZones: [attack('attack-2', 2), attack('attack-1', 1)],
    civilianImpacts: [
        {
            civilianAreaId: 'area-town',
            name: 'Lahaina Town',
            population: 2400,
            impactMin: null,
            gradient: 0,
            exposedFraction: 0,
            severity: 'clear',
        },
        {
            civilianAreaId: 'area-bypass',
            name: 'Bypass Homes',
            population: 140,
            impactMin: 92.3,
            gradient: 0.49,
            exposedFraction: 0.3,
            severity: 'warning',
        },
        {
            civilianAreaId: 'area-unknown',
            name: 'Nowhere',
            population: 1,
            impactMin: 10,
            gradient: 0.9,
            exposedFraction: 1,
            severity: 'immediate',
        },
    ],
    evacuationRoutes: [
        evacuation('area-bypass', 'clear'),
        evacuation('area-town', 'no_safe_route'),
    ],
    sectorRisks: [],
};

function assignment(jobId: string, attackZoneId: string): ResponderAssignment {
    return {
        id: `${jobId}-${attackZoneId}`,
        responderId: 'resp-1',
        zoneId: ZONE,
        incidentId: 'inc-1',
        jobId,
        attackZoneId,
        attackZoneLabel: 'A',
        dropSite: CENTER,
        instructions: '',
        state: 'active',
        createdAt: AT,
        updatedAt: AT,
    };
}

describe('livePlans', () => {
    const plans = livePlans(result, geography, [
        assignment('job-2', 'attack-1'),
        assignment('job-2', 'attack-1'),
        assignment('job-1', 'attack-2'),
    ]);

    it('places civilian impacts at their areas, soonest first', () => {
        const { impacts } = plans.civilian;
        expect(impacts.map((c) => c.communityId)).toEqual(['area-bypass', 'area-town']);
        expect(impacts[0]).toMatchObject({
            name: 'Bypass Homes',
            lat: 20.886,
            lon: -156.668,
            arrivalMin: 92,
            urgency: 0.49,
        });
        expect(impacts[1]!.arrivalMin).toBeNull();
        expect(plans.civilian.generatedAt).toBe(Date.parse(AT));
    });

    it('draws routes that exist, named by their first road, with the alternate', () => {
        const { routes } = plans.civilian;
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({
            id: 'route-area-bypass',
            name: 'Via Lahaina Bypass',
            communityId: 'area-bypass',
            safeZoneId: 'sz-exit',
            distanceKm: 2.5,
            etaMin: 13,
            status: 'clear',
        });
        expect(routes[0]!.alternate).toEqual([
            [CENTER.lat, CENTER.lng],
            [20.86, -156.67],
        ]);
    });

    it('turns attack zones into lettered drop sites with the crews assigned by this plan', () => {
        const { dropSites } = plans.responder;
        expect(dropSites.map((d) => d.name)).toEqual(['Attack zone A', 'Attack zone B']);
        expect(dropSites[0]).toMatchObject({
            id: 'attack-1',
            lat: 20.8877,
            lon: -156.666,
            radiusM: 75,
            crews: 2,
        });
        expect(dropSites[0]!.purpose).toBe('Direct attack · fire in 1h 30m');
        expect(dropSites[1]!.crews).toBe(0);
        expect(plans.responder.spread.cells).toHaveLength(4);
    });
});

describe('openIncident and planJobId', () => {
    const job = (jobId: string, patch: Partial<PlannerJob>): PlannerJob => ({
        jobId,
        zoneId: ZONE,
        state: 'succeeded',
        requestedBy: 'ember',
        requestedAt: AT,
        updatedAt: AT,
        message: null,
        options: {},
        reason: null,
        incidentId: null,
        ...patch,
    });
    const jobs = [
        job('routine-old', { updatedAt: '2026-10-04T03:00:00.000Z' }),
        job('routine-new', { updatedAt: '2026-10-04T05:00:00.000Z' }),
        job('incident-plan', { incidentId: 'inc-old', updatedAt: '2026-10-04T06:00:00.000Z' }),
        job('failed', { state: 'failed', updatedAt: '2026-10-04T07:00:00.000Z' }),
    ];

    it('picks the newest incident still being worked', () => {
        const open = openIncident([
            incident({ id: 'a', number: 1, state: 'active' }),
            incident({ id: 'b', number: 3, state: 'verifying' }),
            incident({ id: 'c', number: 4, state: 'closed' }),
        ]);
        expect(open?.id).toBe('b');
        expect(openIncident([incident({ state: 'contained' })])).toBeNull();
    });

    it("prefers the open incident's plan, else the newest routine plan", () => {
        expect(planJobId(incident({ latestJobId: 'inc-job' }), jobs)).toBe('inc-job');
        expect(planJobId(incident({ latestJobId: null }), jobs)).toBe('routine-new');
        expect(planJobId(null, jobs)).toBe('routine-new');
        expect(planJobId(null, [])).toBeNull();
    });
});

describe('pendingAlerts', () => {
    const approval = (id: string, number: number, patch: Partial<Approval> = {}): Approval => ({
        id,
        number,
        zoneId: ZONE,
        incidentId: 'inc-1',
        state: 'pending',
        draft: {
            kind: 'civilian_alert',
            jobId: 'job-2',
            civilianAreaId: 'area-bypass',
            severity: 'warning',
            recipients: [
                { civilianId: 'c1', body: 'Leave now via Lahaina Bypass.' },
                { civilianId: 'c2', body: 'Leave now, second.' },
            ],
            mapUrl: null,
        },
        reason: 'Bypass Homes is warning',
        draftedBy: 'ember',
        confirmationCode: 'CMQC',
        createdAt: AT,
        decidedBy: null,
        decidedVia: null,
        decidedAt: null,
        decisionNote: null,
        ...patch,
    });

    it('lists pending civilian alerts by number with area, recipients and the first text', () => {
        const alerts = pendingAlerts(
            [
                approval('a7', 7),
                approval('a4', 4),
                approval('a5', 5, { state: 'approved' }),
                approval('a6', 6, {
                    draft: {
                        kind: 'authority_notification',
                        audience: 'fire_department',
                        organization: 'Maui Fire',
                        subject: 'Fire',
                        body: 'Fire',
                    },
                }),
            ],
            geography.civilianAreas,
        );
        expect(alerts.map((a) => a.number)).toEqual([4, 7]);
        expect(alerts[0]).toMatchObject({
            areaName: 'Bypass Homes',
            severity: 'warning',
            recipients: 2,
            firstBody: 'Leave now via Lahaina Bypass.',
        });
        expect(alerts[0]!.approval.confirmationCode).toBe('CMQC');
    });
});
