import { describe, expect, test } from 'vitest';
import type { DetectionRecord, Weather, WatchZoneId } from '@ember/contracts';
import { answer } from './civilian.js';
import { diffPlans } from './diff.js';
import { unsupportedNumbers } from './llm/guard.js';
import { templateAlert } from './playbooks/alerts.js';
import { scanInterval, triage, weatherSeverity } from './policy.js';
import { route as routeIntent } from './intents.js';
import { CONFIG, GEO, impact, result, route, zone } from './testing/fixtures.js';
import { impactView, routeView, usesOfRoads } from './views.js';

const calm: Weather = {
    observedAt: '2023-08-08T06:00:00Z',
    windSpeedMps: 4,
    windFromDeg: 70,
    temperatureC: 22,
    relativeHumidityPct: 70,
    windGustMps: 6,
    redFlagWarning: false,
    source: 'test',
};
const gale: Weather = {
    ...calm,
    windSpeedMps: 17,
    windGustMps: 30,
    relativeHumidityPct: 30,
    temperatureC: 30,
    redFlagWarning: true,
};

const at = (score: number, w: Weather) =>
    scanInterval({
        topSectorScore: score,
        weather: w,
        openDetections: 0,
        activeIncident: false,
    }).intervalMin;

describe('scan cadence', () => {
    test('worse weather and higher risk scan more often, continuously', () => {
        expect(weatherSeverity(gale)).toBeGreaterThan(weatherSeverity(calm));
        expect(at(0.2, calm)).toBeGreaterThan(at(0.4, calm));
        expect(at(0.4, calm)).toBeGreaterThan(at(0.6, calm));
        expect(at(0.4, gale)).toBeLessThan(at(0.4, calm));
        expect(new Set([0.1, 0.2, 0.3, 0.4, 0.5].map((s) => at(s, calm))).size).toBe(5);
    });

    test('open detections and an active incident tighten it, with reasons', () => {
        const open = scanInterval({
            topSectorScore: 0.1,
            weather: calm,
            openDetections: 2,
            activeIncident: false,
        });
        expect(open.intervalMin).toBeLessThanOrEqual(15);
        expect(open.reasons.join()).toContain('2 unconfirmed');
        expect(
            scanInterval({
                topSectorScore: 0.1,
                weather: calm,
                openDetections: 0,
                activeIncident: true,
            }).intervalMin,
        ).toBe(10);
    });
});

const d = (
    id: string,
    confidence: number,
    over: Partial<DetectionRecord> = {},
): DetectionRecord => ({
    id,
    risk: 'on_fire',
    confidence,
    bboxPx: [0, 0, 1, 1],
    ground: [],
    center: { lat: 20.885, lng: -156.669 },
    areaM2: 100,
    droneId: 'd1',
    capturedAt: `2026-10-03T12:00:0${id.length % 10}Z`,
    zoneId: 'z1' as WatchZoneId,
    source: 'drone',
    receivedAt: '2026-10-03T12:00:00Z',
    verification: 'unverified',
    ...over,
});

describe('detection triage', () => {
    test('moderate confidence asks for a second look, once', () => {
        expect(triage(d('a', 0.6), [d('a', 0.6)], CONFIG).action).toBe('verify');
        expect(triage(d('a', 0.6, { verification: 'verifying' }), [], CONFIG).action).toBe('none');
    });

    test('high confidence, or a nearby second detection, confirms', () => {
        expect(triage(d('a', 0.9), [], CONFIG).action).toBe('confirm');
        const t = triage(d('a', 0.6), [d('a', 0.6), d('bb', 0.7, { droneId: 'd2' })], CONFIG);
        expect(t).toMatchObject({ action: 'confirm', corroboratedBy: ['bb'] });
        expect(t.confidence).toBeCloseTo(0.88, 2);
        const far = d('cc', 0.7, { droneId: 'd2', center: { lat: 20.95, lng: -156.669 } });
        expect(triage(d('a', 0.6), [far], CONFIG).action).toBe('verify');
    });

    test('low confidence is watched', () => {
        expect(triage(d('a', 0.2), [], CONFIG).action).toBe('watch');
    });
});

describe('plan diff', () => {
    test('a blocked road shows as a rerouted attack zone and a changed civilian route only', () => {
        const before = result('j1');
        const after = result('j2', {
            attackZones: [zone(1, ['r-bypass']), zone(2, ['r-hwy', 'r-front'])],
            evacuationRoutes: [route('area-bypass', ['r-bypass', 'r-front'], 'sz-south')],
            civilianImpacts: [
                impact('area-bypass', 106, 'warning'),
                impact('area-town', null, 'clear'),
            ],
        });
        expect(usesOfRoads(before, ['r-ridge'])).toEqual({
            attackZones: ['attack-2'],
            evacuationRoutes: [],
        });
        const diff = diffPlans(before, after, GEO);
        expect(diff.attackZones.map((z) => [z.label, z.change])).toEqual([
            ['A', 'unchanged'],
            ['B', 'rerouted'],
        ]);
        expect(diff.attackZones[1]!.detail).toBe(
            'approach via Highway 30, Front St instead of Highway 30, Ridge Rd',
        );
        expect(diff.civilianAreas).toHaveLength(1);
        expect(diff.civilianAreas[0]!.changes).toEqual(['route', 'destination']);
    });

    test('forecast noise under five minutes is not a change', () => {
        const diff = diffPlans(
            result('j1'),
            result('j2', {
                civilianImpacts: [
                    impact('area-bypass', 104, 'warning'),
                    impact('area-town', null, 'clear'),
                ],
            }),
            GEO,
        );
        expect(diff.civilianAreas).toEqual([]);
    });
});

describe('language guard', () => {
    test('rejects numbers the facts do not contain', () => {
        const facts = {
            impact: { fireArrivalMin: 108 },
            route: { etaMin: 13, via: ['Highway 30'] },
        };
        expect(
            unsupportedNumbers('Fire in about 108 min; leave via Highway 30 (13 min).', facts),
        ).toEqual([]);
        expect(unsupportedNumbers('Fire in about 45 min.', facts)).toEqual([45]);
    });
});

describe('civilian texts', () => {
    const facts = {
        area: 'Bypass Homes',
        impact: impactView(impact('area-bypass', 108, 'warning')),
        route: routeView(
            {
                ...route('area-bypass', ['r-bypass', 'r-hwy']),
                alternate: { ...route('area-bypass', ['r-front'], 'sz-south') },
            },
            GEO,
        ),
        mapUrl: 'http://map.test/?zone=z1',
    };

    test('alerts carry the plan, the map and the disclaimer', () => {
        const text = templateAlert({
            ...facts,
            update: false,
            changes: [],
            householdNotes: 'two dogs',
        });
        expect(text).toContain('about 108 min');
        expect(text).toContain('via Lahaina Bypass then Highway 30 toward Kaanapali exit');
        expect(text).toContain('If blocked, use Front St to Puamana Park');
        expect(text).toContain('two dogs');
        expect(text).toContain('not an official order');
        expect(routeView(route('area-bypass', ['r-hwy']), GEO).heads).toBe('north');
    });

    test('answers come from the stored plan', () => {
        const f = {
            civilian: 'Civilian 4',
            roadsNotOpen: [{ name: 'Ridge Rd', state: 'blocked' }],
            notes: [],
            ...facts,
        };
        const q = (question: 'road' | 'evacuate', roadName: string | null = null) =>
            answer(
                {
                    kind: 'question',
                    question,
                    roadName,
                    roadState: null,
                    responderStatus: null,
                    householdNote: null,
                },
                f,
            );
        expect(q('road', 'Highway 30')).toMatch(/^Yes, Highway 30 is on your evacuation route/);
        expect(q('road', 'Front St')).toMatch(/alternate route, to Puamana Park/);
        expect(q('road', 'Ridge Road')).toMatch(/^Ridge Rd is reported blocked/);
        expect(q('evacuate')).toMatch(
            /^Yes\. Ember's forecast has fire reaching Bypass Homes in about 108 min/,
        );
    });
});

describe('rules router', () => {
    test.each([
        ['Analyze wildfire risk around Lahaina.', 'rank_regions'],
        ['What area currently has the greatest wildfire risk?', 'rank_regions'],
        ['Begin surveillance of the highest-risk region.', 'start_scan'],
        ['Simulate a fire in Sector 7.', 'simulate_fire'],
        ['Coordinate the response.', 'coordinate_response'],
        ['Which civilians need evacuation?', 'list_civilians_to_evacuate'],
        ['Show me why Civilian 4 was routed north.', 'explain_route'],
        ['Responder 2 says Ridge Road is blocked.', 'update_road_state'],
        ['What changed because of that?', 'what_changed'],
        ['What happened and why?', 'what_happened'],
        ['Create a watch zone around Paradise, California', 'create_watch_zone'],
        ['Reset the demo', 'reset_demo'],
    ])('%s', (text, tool) => {
        expect(routeIntent(text)[0]?.name).toBe(tool);
    });

    test('arguments come from the words used', () => {
        expect(routeIntent('Simulate a fire in Sector 7.')[0]!.args).toEqual({ sector: 'S7' });
        expect(routeIntent('Show me why Civilian 4 was routed north.')[0]!.args).toEqual({
            civilianNumber: 4,
        });
        expect(routeIntent('Responder 2 says Ridge Road is blocked.')[0]!.args).toMatchObject({
            roadName: 'Ridge Road',
            state: 'blocked',
            reporter: 'Responder 2',
        });
    });
});
