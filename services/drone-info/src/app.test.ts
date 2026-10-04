import { afterEach, expect, test } from 'vitest';
import type { DroneInfoMessage } from '@ember/contracts';
import { buildApp } from './app.js';

const pose = { lat: 20.8838, lng: -156.667, altM: 60, headingDeg: 90, pitchDeg: -90 };
const camera = { widthPx: 160, heightPx: 120, hfovDeg: 84 };

const hello = (droneId: string) => ({
    type: 'hello',
    droneId,
    name: `Sim ${droneId}`,
    kind: 'simulated',
    camera,
    sensors: ['rgb', 'thermal'],
    maxSpeedMps: 10,
    enduranceS: 1500,
});

const telemetry = (droneId: string, batteryPct = 90) => ({
    type: 'telemetry',
    droneId,
    sentAt: '2026-10-03T12:00:00Z',
    scenarioTime: '2023-08-08T15:10:00-10:00',
    scenarioSpeed: 30,
    pose,
    camera,
    velocity: { eastMps: 8, northMps: 0, upMps: 0 },
    batteryPct,
    mode: 'patrol',
});

const detections = (droneId: string) => ({
    type: 'detections',
    droneId,
    frameId: 7,
    capturedAt: '2026-10-03T12:00:00Z',
    scenarioTime: '2023-08-08T15:10:00-10:00',
    pose,
    camera,
    detector: 'heuristic',
    detections: [
        {
            id: `${droneId}-7-0`,
            risk: 'on_fire',
            confidence: 0.9,
            bboxPx: [10, 10, 40, 30],
            ground: [pose, pose, pose, pose].map(({ lat, lng }) => ({ lat, lng })),
            center: { lat: pose.lat, lng: pose.lng },
            areaM2: 120,
            peakTempK: 900,
        },
    ],
});

let app = buildApp({ fleetIntervalMs: 50 });
afterEach(async () => {
    await app.close();
    app = buildApp({ fleetIntervalMs: 50 });
});

const ingest = (messages: unknown[]) =>
    app.inject({ method: 'POST', url: '/v1/ingest', payload: { messages } });

test('health', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ service: 'drone-info', ok: true });
});

test('ingest keeps good messages and reports bad ones', async () => {
    const bad = { ...telemetry('d1'), pose: { lat: 1 } };
    const res = await ingest([hello('d1'), telemetry('d1'), bad, { type: 'launch', droneId: 'x' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
        accepted: 2,
        rejected: 2,
        errors: [
            'telemetry from d1: bad pose, camera, velocity, battery, mode or clock',
            'unknown message type launch',
        ],
    });
    const missing = await app.inject({ method: 'POST', url: '/v1/ingest', payload: {} });
    expect(missing.statusCode).toBe(400);
});

type Next = <T extends DroneInfoMessage['type']>(
    type: T,
) => Promise<Extract<DroneInfoMessage, { type: T }>>;

/** A viewer on the stream; `next(type)` skips other message types until one of `type` comes. */
async function open(): Promise<{ next: Next; send: (m: unknown) => void }> {
    await app.ready();
    const ws = await app.injectWS('/v1/stream');
    const queue: DroneInfoMessage[] = [];
    let waiter: { type: string; resolve: (m: DroneInfoMessage) => void } | null = null;
    ws.on('message', (data: Buffer) => {
        const m = JSON.parse(data.toString()) as DroneInfoMessage;
        if (waiter?.type === m.type) {
            const { resolve } = waiter;
            waiter = null;
            resolve(m);
        } else if (!waiter) queue.push(m);
    });
    const next = ((type: string) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(queue.splice(0, i + 1)[i]);
        queue.length = 0;
        return new Promise((resolve) => (waiter = { type, resolve }));
    }) as Next;
    return { next, send: (m) => ws.send(JSON.stringify(m)) };
}

test('stream sends the fleet, then the followed drone only', async () => {
    await ingest([hello('d1'), telemetry('d1'), detections('d1'), telemetry('d2')]);
    const { next, send } = await open();
    const fleet = await next('fleet');
    expect(fleet.drones.map((d) => [d.droneId, d.name, d.kind])).toEqual([
        ['d1', 'Sim d1', 'simulated'],
        ['d2', 'd2', 'physical'],
    ]);

    send({ type: 'follow', droneId: 'd1' });
    expect((await next('telemetry')).droneId).toBe('d1');
    expect((await next('detections')).detections[0]?.risk).toBe('on_fire');

    await ingest([telemetry('d2', 50), telemetry('d1', 42)]);
    const live = await next('telemetry');
    expect([live.droneId, live.batteryPct]).toEqual(['d1', 42]);

    const later = await next('fleet');
    expect(later.drones.find((d) => d.droneId === 'd2')?.batteryPct).toBe(50);
});
