import { describe, expect, it } from 'vitest';
import {
    RESPONDER_PAIRING_KIND,
    type ResponderMessage,
    type TerrainGrid,
    type WatchZoneId,
} from '@ember/contracts';
import { demoBundle } from '../demo/bundle';
import { buildGeometry, hitAttack } from '../map/geometry';
import { mergeMessages, unreadCount } from './feed';
import { compass, minutes } from './format';
import { fitCamera, makeProjection, screenToWorld } from './geo';
import { parsePairingCode } from './pairing';
import { fuelRuns } from './terrain';

const NOW = Date.parse('2026-10-03T12:00:00Z');

function code(over: Record<string, unknown> = {}) {
    return JSON.stringify({
        kind: RESPONDER_PAIRING_KIND,
        v: 1,
        apiUrl: 'https://api.ember.test/',
        zoneId: 'zone-1',
        zoneName: 'Ridge',
        token: 'abc',
        expiresAt: '2026-10-03T12:10:00Z',
        ...over,
    });
}

describe('parsePairingCode', () => {
    it('accepts a valid code and trims the api url', () => {
        const r = parsePairingCode(code(), NOW);
        expect(r.ok && r.code.apiUrl).toBe('https://api.ember.test');
    });

    it('ignores QR codes that are not ours', () => {
        expect(parsePairingCode('https://example.com', NOW)).toEqual({
            ok: false,
            reason: 'not_ember',
        });
        expect(parsePairingCode('{"kind":"other"}', NOW)).toEqual({
            ok: false,
            reason: 'not_ember',
        });
    });

    it('rejects expired and malformed codes', () => {
        expect(parsePairingCode(code({ expiresAt: '2026-10-03T11:00:00Z' }), NOW)).toEqual({
            ok: false,
            reason: 'expired',
        });
        expect(parsePairingCode(code({ apiUrl: 'javascript:alert(1)' }), NOW)).toEqual({
            ok: false,
            reason: 'invalid',
        });
        expect(parsePairingCode(code({ token: '' }), NOW)).toEqual({
            ok: false,
            reason: 'invalid',
        });
    });
});

describe('fuelRuns', () => {
    const grid: TerrainGrid = {
        southWest: { lat: 0, lng: 0 },
        cellSizeM: 10,
        cols: 4,
        rows: 2,
        elevationM: null,
        fuel: ['grass', 'grass', 'none', 'timber', 'shrub', 'shrub', 'shrub', 'shrub'],
    };

    it('merges same-fuel cells and drops non-fuel', () => {
        expect(fuelRuns(grid).runs).toEqual([
            { row: 0, col: 0, len: 2, fuel: 'grass' },
            { row: 0, col: 3, len: 1, fuel: 'timber' },
            { row: 1, col: 0, len: 4, fuel: 'shrub' },
        ]);
    });

    it('samples large grids down', () => {
        const big: TerrainGrid = {
            ...grid,
            cols: 400,
            rows: 400,
            fuel: Array(160_000).fill('grass'),
        };
        const { runs, step } = fuelRuns(big, 100);
        expect(step).toBe(4);
        expect(runs).toHaveLength(100);
        expect(runs[0]!.len).toBe(400);
    });
});

describe('geo', () => {
    it('round-trips through the projection', () => {
        const p = makeProjection({ lat: 20.87, lng: -156.67 });
        const back = p.toLatLng(p.toXY({ lat: 20.9, lng: -156.6 }));
        expect(back.lat).toBeCloseTo(20.9, 9);
        expect(back.lng).toBeCloseTo(-156.6, 9);
    });

    it('fits bounds and maps the screen centre to the bounds centre', () => {
        const size = { width: 400, height: 800 };
        const cam = fitCamera({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, size, 0);
        expect(cam.scale).toBe(2);
        expect(screenToWorld(cam, size, { x: 200, y: 400 })).toEqual({ x: 0, y: 0 });
    });
});

const msg = (id: string, sentAt: string): ResponderMessage => ({
    id,
    zoneId: 'z' as WatchZoneId,
    kind: 'update',
    priority: 'routine',
    title: id,
    body: '',
    sentAt,
    from: 'ember',
    location: null,
});

describe('feed', () => {
    it('dedupes by id and sorts newest first', () => {
        const merged = mergeMessages(
            [msg('a', '2026-10-03T10:00:00Z'), msg('b', '2026-10-03T11:00:00Z')],
            [msg('b', '2026-10-03T11:00:00Z'), msg('c', '2026-10-03T12:00:00Z')],
        );
        expect(merged.map((m) => m.id)).toEqual(['c', 'b', 'a']);
        expect(unreadCount(merged, '2026-10-03T10:30:00Z')).toBe(2);
    });
});

describe('format', () => {
    it('formats minutes and headings', () => {
        expect(minutes(95)).toBe('1h 35m');
        expect(minutes(120)).toBe('2h');
        expect(compass(252)).toBe('W');
        expect(compass(-45)).toBe('NW');
    });
});

describe('buildGeometry', () => {
    const bundle = demoBundle(NOW);
    const g = buildGeometry(bundle);

    it('projects every layer of the bundle', () => {
        expect(g.fuel.length).toBeGreaterThan(0);
        expect(g.isochrones.map((i) => i.atMin)).toEqual([180, 150, 120, 90, 60, 30]);
        expect(g.attack).toHaveLength(bundle.plan!.attackZones.length);
        expect(g.head?.deg).toBe(bundle.plan!.headingDeg);
    });

    it('hits the attack site under a tap', () => {
        const site = bundle.plan!.attackZones[0]!;
        expect(hitAttack(g, g.proj.toXY(site.center), 0)?.id).toBe(site.id);
        expect(hitAttack(g, { x: 1e6, y: 1e6 }, 0)).toBeNull();
    });
});
