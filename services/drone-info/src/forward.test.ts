import { afterEach, expect, test, vi } from 'vitest';
import type { DroneDetections } from '@ember/contracts';
import { DetectionForwarder } from './forward.js';

const frame = (frameId: number): DroneDetections => ({
    type: 'detections',
    droneId: 'd1',
    frameId,
    capturedAt: '2026-10-03T12:00:00Z',
    scenarioTime: '2023-08-08T15:10:00-10:00',
    pose: { lat: 20.88, lng: -156.66, altM: 60, headingDeg: 90, pitchDeg: -90 },
    camera: { widthPx: 160, heightPx: 120, hfovDeg: 84 },
    detector: 'heuristic',
    detections: [],
});

const ok = () => new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: 200 });

let forwarder: DetectionForwarder | undefined;
afterEach(() => {
    forwarder?.close();
    vi.useRealTimers();
});

test('posts the frame with the bearer key', async () => {
    const fetchFn = vi.fn<() => Promise<Response>>(async () => ok());
    forwarder = new DetectionForwarder({
        apiUrl: 'http://api:4000/',
        key: 'k',
        fetch: fetchFn as unknown as typeof fetch,
    });
    forwarder.push(frame(1));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api:4000/v1/detections');
    expect(init.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(JSON.parse(init.body as string)).toEqual(frame(1));
});

test('retries 5xx and network errors with backoff, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(ok());
    forwarder = new DetectionForwarder({
        apiUrl: 'http://api',
        fetch: fetchFn as unknown as typeof fetch,
    });
    forwarder.push(frame(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
});

test('drops a frame on 4xx and moves on', async () => {
    const warn = vi.fn<(obj: object, msg: string) => void>();
    const fetchFn = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response('', { status: 400 }))
        .mockResolvedValue(ok());
    forwarder = new DetectionForwarder({
        apiUrl: 'http://api',
        fetch: fetchFn as unknown as typeof fetch,
        logger: { warn },
    });
    forwarder.push(frame(1));
    forwarder.push(frame(2));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(forwarder.dropped).toBe(1);
    const sent = fetchFn.mock.calls.map(
        (c) => JSON.parse((c[1] as RequestInit).body as string).frameId,
    );
    expect(sent).toEqual([1, 2]);
});

test('queue overflow drops the oldest frames', async () => {
    const release: (() => void)[] = [];
    const seen: number[] = [];
    const fetchFn = vi.fn<(url: unknown, init: { body: string }) => Promise<Response>>(
        (_url, init) =>
            new Promise<Response>((resolve) => {
                seen.push(JSON.parse(init.body).frameId);
                release.push(() => resolve(ok()));
            }),
    );
    forwarder = new DetectionForwarder({
        apiUrl: 'http://api',
        fetch: fetchFn as unknown as typeof fetch,
    });
    for (let i = 0; i < 502; i += 1) forwarder.push(frame(i));
    expect(forwarder.dropped).toBe(2);
    release[0]!();
    await vi.waitFor(() => expect(seen.length).toBe(2));
    expect(seen).toEqual([0, 2]);
});
