import { expect, test } from 'vitest';
import type { CivilianAlertDraft, WatchZone } from '@ember/contracts';
import { context, C, GEO, result, route } from '../testing/fixtures.js';
import { alertMap } from './alertMap.js';
import type { GeminiMapImager } from './imagery.js';
import { renderMapPng, renderMapSvg } from './render.js';

const boundary = [
    { lat: C.lat - 0.02, lng: C.lng - 0.02 },
    { lat: C.lat - 0.02, lng: C.lng + 0.02 },
    { lat: C.lat + 0.02, lng: C.lng + 0.02 },
    { lat: C.lat + 0.02, lng: C.lng - 0.02 },
];
const plan = result('j1', {
    evacuationRoutes: [
        {
            ...route('area-bypass', ['r-hwy']),
            alternate: { ...route('area-bypass', ['r-front'], 'sz-south') },
        },
    ],
});
const input = {
    title: 'Evacuation route: Bypass Homes',
    boundary,
    roads: GEO.roads.map((r) => (r.id === 'r-ridge' ? { ...r, state: 'blocked' as const } : r)),
    area: GEO.civilianAreas[0]!,
    result: plan,
    safeZones: GEO.safeZones,
};

test('the map is drawn from the plan: route, alternate, closed road, destination, disclaimer', () => {
    const svg = renderMapSvg(input);
    expect(svg).toContain('stroke="#16a34a" stroke-width="10"');
    expect(svg).toContain('stroke="#0891b2" stroke-width="8"');
    expect(svg).toContain('stroke="#dc2626" stroke-width="5" stroke-dasharray');
    expect(svg).toContain('>Kaanapali exit<');
    expect(svg).toContain('not an official order');
    const png = renderMapPng(input);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
});

const draft: CivilianAlertDraft = {
    kind: 'civilian_alert',
    jobId: 'j1',
    civilianAreaId: 'area-bypass',
    severity: 'warning',
    recipients: [],
    mapUrl: null,
};
const api = {
    zone: async () => ({ id: 'z1', boundary }) as unknown as WatchZone,
    geography: async () => ({ terrain: null, stations: [], ...GEO }),
    plan: async () => ({ job: {} as never, result: plan }),
};

test('Gemini restyles the render, and any failure sends the render instead', async () => {
    const styled = {
        stylize: async () => ({
            data: Buffer.from('x'),
            mimeType: 'image/png',
            generatedBy: 'gemini:test',
        }),
    } as unknown as GeminiMapImager;
    expect((await alertMap(context(api, { imager: styled }), 'z1', draft))!.generatedBy).toBe(
        'gemini:test',
    );
    const broken = {
        stylize: async () => {
            throw new Error('quota');
        },
    } as unknown as GeminiMapImager;
    const fallback = (await alertMap(context(api, { imager: broken }), 'z1', draft))!;
    expect(fallback.generatedBy).toBe('render');
    expect(fallback.data.subarray(1, 4).toString()).toBe('PNG');
});
