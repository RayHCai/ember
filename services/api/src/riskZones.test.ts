import { expect, test } from 'vitest';
import type { LatLng } from '@ember/contracts';
import { centroid, projection } from './geo.js';
import { mergeRiskZones, type RiskFrame } from './riskZones.js';

const boundary: LatLng[] = [
    { lat: 20.87, lng: -156.69 },
    { lat: 20.87, lng: -156.67 },
    { lat: 20.89, lng: -156.67 },
    { lat: 20.89, lng: -156.69 },
];
const proj = projection(centroid(boundary));
const anchor = proj.toXY({ lat: 20.87, lng: -156.69 });
/** A point `x` m east and `y` m north of the boundary's south-west corner. */
const at = (x: number, y: number) => proj.toLatLng({ x: anchor.x + x, y: anchor.y + y });
const rect = (x0: number, y0: number, x1: number, y1: number) => [
    at(x0, y0),
    at(x1, y0),
    at(x1, y1),
    at(x0, y1),
];

type Det = RiskFrame['detections'][number];
const det = (detectionId: string, risk: Det['risk'], ground: LatLng[], confidence = 0.8): Det => ({
    detectionId,
    risk,
    confidence,
    ground,
    center: ground[0] ?? at(0, 0),
});
const frame = (id: string, droneId: string, minute: number, detections: Det[]): RiskFrame => ({
    id,
    droneId,
    capturedAt: new Date(Date.UTC(2026, 9, 4, 12, minute)),
    detections,
});

test('overlapping detections of one class merge into one zone', () => {
    const zones = mergeRiskZones(boundary, [
        frame('f2', 'drone-b', 5, [det('d1', 'on_fire', rect(100, 100, 150, 150), 0.9)]),
        frame('f1', 'drone-a', 1, [det('d1', 'on_fire', rect(120, 120, 200, 200), 0.6)]),
    ]);
    expect(zones).toHaveLength(1);
    const [zone] = zones;
    expect(zone).toMatchObject({
        id: 'on_fire:10:10',
        risk: 'on_fire',
        confidence: 0.9,
        detections: 2,
        droneIds: ['drone-a', 'drone-b'],
        firstSeenAt: '2026-10-04T12:01:00.000Z',
        observedAt: '2026-10-04T12:05:00.000Z',
    });
    // 5 x 5 cells, plus 8 x 8 cells, less the 3 x 3 they share.
    expect(zone!.areaM2).toBe((25 + 64 - 9) * 100);
    const sw = at(100, 100);
    const ne = at(200, 200);
    expect(zone!.bbox.south).toBeCloseTo(sw.lat, 9);
    expect(zone!.bbox.west).toBeCloseTo(sw.lng, 9);
    expect(zone!.bbox.north).toBeCloseTo(ne.lat, 9);
    expect(zone!.bbox.east).toBeCloseTo(ne.lng, 9);
    expect(zone!.polygon.length).toBeGreaterThanOrEqual(4);
    for (const p of zone!.polygon) {
        expect(p.lat).toBeGreaterThanOrEqual(zone!.bbox.south - 1e-9);
        expect(p.lat).toBeLessThanOrEqual(zone!.bbox.north + 1e-9);
    }
});

test('on fire beats at risk per cell, and the rest of the at-risk area stays its own zone', () => {
    const zones = mergeRiskZones(boundary, [
        frame('f1', 'drone-a', 1, [
            det('d1', 'at_risk', rect(0, 0, 100, 50), 0.95),
            det('d2', 'on_fire', rect(0, 0, 50, 50), 0.7),
            det('d3', 'at_risk', rect(500, 500, 520, 520)),
        ]),
    ]);
    expect(zones.map((z) => [z.id, z.areaM2, z.confidence])).toEqual([
        ['on_fire:0:0', 2500, 0.7],
        ['at_risk:0:5', 2500, 0.95],
        ['at_risk:50:50', 400, 0.8],
    ]);
});

test('cells touching at a corner are one zone', () => {
    const zones = mergeRiskZones(boundary, [
        frame('f1', 'drone-a', 1, [
            det('d1', 'on_fire', rect(0, 0, 10, 10)),
            det('d2', 'on_fire', rect(10, 10, 20, 20)),
        ]),
    ]);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.areaM2).toBe(200);
});

test('a detection with no outline counts as the cell under its centre', () => {
    const zones = mergeRiskZones(boundary, [
        frame('f1', 'drone-a', 1, [{ ...det('d1', 'on_fire', []), center: at(35, 45) }]),
    ]);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ id: 'on_fire:4:3', areaM2: 100, detections: 1 });
    expect(zones[0]!.center.lat).toBeCloseTo(at(35, 45).lat, 9);
});

test('detection ids repeat across frames and are counted per frame', () => {
    const ground = rect(0, 0, 30, 30);
    const zones = mergeRiskZones(boundary, [
        frame('f1', 'drone-a', 1, [det('d1', 'at_risk', ground)]),
        frame('f2', 'drone-a', 2, [det('d1', 'at_risk', ground)]),
    ]);
    expect(zones[0]!.detections).toBe(2);
    expect(mergeRiskZones(boundary, [])).toEqual([]);
});
