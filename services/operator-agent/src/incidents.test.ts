import { beforeEach, expect, test } from 'vitest';
import { LogTransport } from './channels.js';
import { AGENT, IncidentLoop } from './incidents.js';
import { config, FakeApi, fire, T0, ZIPS } from './testing/fake.js';

let now: Date;
let api: FakeApi;
let transport: LogTransport;
let loop: IncidentLoop;
const advance = (ms: number) => (now = new Date(now.getTime() + ms));
const silent = { info: () => {}, warn: () => {} };

beforeEach(() => {
    now = new Date(T0);
    api = new FakeApi(() => now);
    transport = new LogTransport();
    loop = new IncidentLoop({
        api,
        transport,
        zipOf: async (p) => ZIPS[`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`] ?? null,
        config,
        log: silent,
        now: () => now,
    });
});

const evacuations = () => api.blastList.filter((b) => b.audience === 'civilians');

test('no fire, no plan and no alerts', async () => {
    await loop.tick();
    expect(api.jobs).toEqual([]);
    expect(api.blastList).toEqual([]);
    expect(loop.status.get('zone-1')?.onFire).toBe(0);
    expect(loop.lastTick?.ok).toBe(true);
});

test('a fire gets one plan, then responder staging and one evacuation draft per zip', async () => {
    api.riskZoneList = [fire()];
    advance(1_000);
    await loop.tick();
    await loop.tick();
    expect(api.jobs.map((j) => [j.requestedBy, j.state])).toEqual([[AGENT, 'queued']]);
    expect(api.blastList).toEqual([]);

    api.finishPlan();
    await loop.tick();
    expect(evacuations().map((b) => [b.title, b.state])).toEqual([
        ['Evacuation ZIP 96761: Kahana, Napili', 'pending_approval'],
        ['Evacuation ZIP 96767: Front Street', 'pending_approval'],
    ]);
    const briefs = api.blastList.filter((b) => b.audience === 'responders');
    expect(briefs.map((b) => [b.title, b.state])).toEqual([
        ['Responder staging: Lahaina', 'queued'],
    ]);
    expect(transport.sent).toEqual([]);

    await loop.tick();
    expect(api.blastList).toHaveLength(3);
    const status = loop.status.get('zone-1')!;
    expect(status.plan).toEqual({ jobId: 'job-1', state: 'succeeded' });
    expect(status.responders.map((z) => z.rank)).toEqual([1, 2, 3]);
    expect(status.evacuations.map((e) => [e.zipCode, e.state])).toEqual([
        ['96767', 'pending_approval'],
        ['96761', 'pending_approval'],
    ]);
});

test('nothing reaches a civilian until an operator approves, then only their zip, once', async () => {
    api.riskZoneList = [fire()];
    await loop.tick();
    api.finishPlan();
    await loop.tick();
    await loop.tick();
    expect(transport.sent).toEqual([]);

    const draft = evacuations().find((b) => b.title.startsWith('Evacuation ZIP 96761'))!;
    advance(60_000);
    api.approve(draft.blastId, now);
    await loop.tick();
    await loop.tick();
    expect(transport.sent).toEqual([
        { phone: '+18085550001', body: draft.body },
        { phone: '+18085550002', body: draft.body },
    ]);
    expect(
        loop.status.get('zone-1')!.evacuations.find((e) => e.zipCode === '96761')?.delivered,
    ).toEqual({
        sent: 2,
        failed: 0,
    });
});

test('a failed send is counted and the rest still go out', async () => {
    api.riskZoneList = [fire()];
    await loop.tick();
    api.finishPlan();
    await loop.tick();
    const draft = evacuations().find((b) => b.title.startsWith('Evacuation ZIP 96761'))!;
    api.approve(draft.blastId, now);
    const sent: string[] = [];
    transport.send = async (phone) => {
        if (phone === '+18085550001') throw new Error('not on iMessage');
        sent.push(phone);
    };
    await loop.tick();
    expect(sent).toEqual(['+18085550002']);
    expect(
        loop.status.get('zone-1')!.evacuations.find((e) => e.zipCode === '96761')?.delivered,
    ).toEqual({
        sent: 1,
        failed: 1,
    });
});

test('approvals from before the lookback are not sent again after a restart', async () => {
    api.riskZoneList = [fire()];
    await loop.tick();
    api.finishPlan();
    await loop.tick();
    const draft = evacuations()[0]!;
    api.approve(draft.blastId, new Date(now.getTime() - 2 * 3600_000));
    await loop.tick();
    expect(transport.sent).toEqual([]);
});

test('a responder brief from before this fire does not stop a new incident', async () => {
    api.blastList.push({
        blastId: 'old',
        zoneId: 'zone-1' as never,
        audience: 'responders',
        priority: 'urgent',
        area: 'near_fire',
        title: 'Responder staging: Lahaina',
        body: 'old',
        state: 'queued',
        createdBy: 'service',
        createdAt: '2026-10-01T00:00:00.000Z',
        approval: null,
    });
    api.riskZoneList = [fire()];
    await loop.tick();
    api.finishPlan();
    await loop.tick();
    expect(evacuations()).toHaveLength(2);
});

test('a failed plan is requested again after the retry interval', async () => {
    api.riskZoneList = [fire()];
    await loop.tick();
    api.finishPlan('failed');
    await loop.tick();
    expect(api.jobs).toHaveLength(1);
    advance(config.planRetryMs);
    await loop.tick();
    expect(api.jobs.map((j) => j.state)).toEqual(['failed', 'queued']);
});

test('a zone that fails to read does not stop the tick', async () => {
    api.riskZones = async () => {
        throw new Error('api down');
    };
    await loop.tick();
    expect(loop.lastTick).toEqual({ at: T0, ok: false });
});
