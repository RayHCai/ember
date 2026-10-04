import { expect, test, vi } from 'vitest';
import type { EdgeServerStatus, StopMappingTask, WatchZoneId } from '@ember/contracts';
import { createEdgeManager, EdgeManagerError } from './edgeManager.js';

const status: EdgeServerStatus = {
    edgeServerId: 'edge-a',
    url: 'http://10.0.0.2:8070',
    online: true,
    connectedAt: '2026-10-04T00:00:00Z',
    lastSeen: '2026-10-04T00:01:00Z',
    drones: 3,
    connectedDrones: 2,
    run: null,
};

const json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
    });

test('live status is cached briefly and sent with the edge key', async () => {
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json([status]));
    const manager = createEdgeManager({
        url: 'http://edge-manager:8080/',
        key: 'edge-key',
        fetch,
        now: () => clock,
    });
    const [a, b] = await Promise.all([manager.live(), manager.live()]);
    expect(a?.get('edge-a')).toEqual(status);
    expect(b).toBe(a);
    clock = 2_500;
    await manager.live();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://edge-manager:8080/v1/edge-servers');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer edge-key');
});

test('an unreachable edge-manager is null live status and a task error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        throw new TypeError('fetch failed');
    });
    const manager = createEdgeManager({ url: 'http://edge-manager:8080', fetch });
    expect(await manager.live()).toBeNull();
    const task: StopMappingTask = {
        kind: 'stop_mapping',
        runId: 'run-1',
        zoneId: '00000000-0000-4000-8000-000000000001' as WatchZoneId,
        edgeServers: [],
    };
    await expect(manager.task(task)).rejects.toThrow(EdgeManagerError);

    const refusing = createEdgeManager({
        url: 'http://edge-manager:8080',
        fetch: async () => json({ error: 'bad task' }, { status: 400 }),
    });
    await expect(refusing.task(task)).rejects.toThrow('edge-manager answered 400: bad task');
});
