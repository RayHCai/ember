import { beforeEach, expect, test } from 'vitest';
import type { RiskZone } from '@ember/contracts';
import { LogTransport } from './channels.js';
import { frame, renderMapSvg } from './map.js';
import { Notices } from './notices.js';
import { FakeApi, fire, result, surroundings, T0, zone } from './testing/fake.js';

const PHONE = '+16025550100';
let now: Date;
let api: FakeApi;
let transport: LogTransport;
let notices: Notices;
const silent = { info: () => {}, warn: () => {} };

const risk = (id: string): RiskZone => ({
    ...fire(),
    id,
    risk: 'at_risk',
    center: { lat: 20.968, lng: -156.68 },
});

const newPlan = async () => {
    await api.requestPlan(zone.id, 'operator-1');
    api.finishPlan();
};

beforeEach(() => {
    now = new Date(T0);
    api = new FakeApi(() => now);
    transport = new LogTransport();
    notices = new Notices({
        api,
        transport,
        phone: PHONE,
        log: silent,
        tiles: async () => null,
        timeZone: 'Pacific/Honolulu',
        now: () => now,
    });
});

test('a fire or risk area texts nothing before its plan', async () => {
    await notices.watch();
    api.riskZoneList = [fire(), risk('at_risk:1:1')];
    await notices.watch();
    expect(transport.sent).toEqual([]);
    expect(transport.images).toEqual([]);
});

test('a plan already there at the first look is the baseline, not news', async () => {
    await newPlan();
    await notices.watch();
    expect(transport.sent).toEqual([]);
});

test('a new plan texts when and how to leave the first area hit, then its map', async () => {
    api.riskZoneList = [fire()];
    await notices.watch();
    await newPlan();
    await notices.watch();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.body).toBe(
        'Ember Alert: Evacuate by 12:15 am HST via Honoapiilani Hwy to Kapalua Airport.',
    );
    expect(transport.images).toHaveLength(1);
    expect(transport.images[0]).toMatchObject({
        phone: PHONE,
        mimeType: 'image/png',
        name: 'ember-evacuation-route.png',
    });
    expect(transport.images[0]!.bytes).toBeGreaterThan(10_000);

    await notices.watch();
    expect(transport.sent).toHaveLength(1);
    expect(api.civilians.length).toBe(4);
});

test('the map is drawn before the text is sent', async () => {
    await notices.watch();
    await newPlan();
    const draw = api.riskZones.bind(api);
    api.riskZones = async () => {
        throw new Error('risk zones unreadable');
    };
    await notices.watch();
    expect(transport.sent).toEqual([]);
    api.riskZones = draw;
    await notices.watch();
    expect(transport.sent).toHaveLength(1);
    expect(transport.images).toHaveLength(1);
});

test('a plan with no safe route sends the text without a map', async () => {
    await notices.watch();
    api.planResult = {
        ...result,
        evacuationRoutes: result.evacuationRoutes.filter((r) => r.status === 'no_safe_route'),
    };
    await newPlan();
    await notices.watch();
    expect(transport.sent[0]!.body).toContain('No safe road out was found');
    expect(transport.images).toEqual([]);
});

test('a plan text that fails is tried again next tick, then not again', async () => {
    await notices.watch();
    await newPlan();
    const send = transport.send.bind(transport);
    transport.send = async () => {
        throw new Error('[upstream] replies are limited');
    };
    await notices.watch();
    expect(transport.sent).toEqual([]);
    expect(transport.images).toEqual([]);
    transport.send = send;
    await notices.watch();
    expect(transport.sent).toHaveLength(1);
    expect(transport.images).toHaveLength(1);
    await notices.watch();
    expect(transport.sent).toHaveLength(1);
});

test('a zone added while running texts its first plan', async () => {
    api.zoneList = [];
    await notices.watch();
    api.zoneList = [zone];
    await newPlan();
    await notices.watch();
    expect(transport.sent).toHaveLength(1);
});

test('the map joins the area to the route, framed with the zone and the fire', async () => {
    const route = result.evacuationRoutes[0]!;
    const from = { ...surroundings.civilianAreas[0]!, center: { lat: 20.965, lng: -156.685 } };
    const watch = {
        ...zone,
        boundary: [
            { lat: 20.95, lng: -156.69 },
            { lat: 20.95, lng: -156.68 },
            { lat: 20.94, lng: -156.68 },
        ],
    };
    const burning = { ...fire(), polygon: [...watch.boundary] };
    const asked: string[] = [];
    const svg = await renderMapSvg(
        { surroundings, zone: watch, route, from, onFire: [burning] },
        async (z, x, y) => {
            asked.push(`${z}/${x}/${y}`);
            return Buffer.from('tile');
        },
    );
    const shown = frame([
        ...route.path,
        from.center,
        route.destination!.location,
        ...watch.boundary,
        ...burning.polygon,
    ]);
    const [sx, sy] = shown.at(route.path[0]!);
    const [fx, fy] = shown.at(from.center);
    expect(svg).toContain(`M${fx.toFixed(1)} ${fy.toFixed(1)} L${sx.toFixed(1)} ${sy.toFixed(1)}`);
    for (const p of [...watch.boundary, route.destination!.location]) {
        const [x, y] = shown.at(p);
        expect(x > 0 && x < 1024 && y > 0 && y < 1024).toBe(true);
    }
    const n = 2 ** shown.z;
    const start = route.path[0]!;
    const tx = Math.floor(((start.lng + 180) / 360) * n);
    const lat = (start.lat * Math.PI) / 180;
    const ty = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
    expect(asked).toContain(`${shown.z}/${tx}/${ty}`);
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain('>Kahana<');
    expect(svg).not.toContain('You');
    expect(svg).toContain('Kapalua Airport');
    expect(svg).toContain('>Lahaina<');
    expect(svg).toContain('© OpenStreetMap contributors');
});
