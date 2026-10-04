import { describe, expect, test } from 'vitest';
import type {
    Approval,
    AssignRespondersResult,
    Civilian,
    DetectionRecord,
    Incident,
    PlannerContext,
    PlannerJob,
    PlannerResult,
    Responder,
    ResponderPairingCode,
    ResponderSession,
    ResponderZoneBundle,
    RoadObservation,
    Scan,
    WatchZone,
} from '@ember/contracts';
import { attackZone, CENTER, harness, plannerResult, square } from './testing/harness.js';

type H = ReturnType<typeof harness>;

async function zone(h: H): Promise<WatchZone> {
    const res = await h.app.inject({
        method: 'POST',
        url: '/v1/watch-zones',
        payload: { name: 'Lahaina', boundary: square(CENTER) },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
}

const GEOGRAPHY = {
    terrain: null,
    roads: [
        {
            id: 'r-hwy',
            name: 'Highway 30 (Honoapiilani Hwy)',
            kind: 'primary',
            path: [CENTER, { lat: 20.88, lng: -156.675 }],
        },
        {
            id: 'r-ridge',
            name: 'Ridge Rd',
            kind: 'track',
            path: [CENTER, { lat: 20.875, lng: -156.67 }],
        },
        {
            id: 'r-ridge-2',
            name: 'Ridge Rd',
            kind: 'track',
            path: [
                { lat: 20.875, lng: -156.67 },
                { lat: 20.877, lng: -156.668 },
            ],
        },
        {
            id: 'r-front',
            name: 'Front St',
            kind: 'secondary',
            path: [CENTER, { lat: 20.87, lng: -156.68 }],
        },
        {
            id: 'r-front-n',
            name: 'Front Street North',
            kind: 'secondary',
            path: [CENTER, { lat: 20.88, lng: -156.68 }],
        },
    ],
    civilianAreas: [
        { id: 'area-kahoma', name: 'Kahoma', center: CENTER, polygon: null, population: 900 },
    ],
    safeZones: [{ id: 'sz-1', name: 'Civic Center', location: CENTER, capacity: null }],
    stations: [{ id: 'station-1', name: 'Station 3', location: CENTER }],
};

async function zoneWithGeography(h: H): Promise<WatchZone> {
    const z = await zone(h);
    const res = await h.app.inject({
        method: 'PUT',
        url: `/v1/watch-zones/${z.id}/geography`,
        payload: GEOGRAPHY,
    });
    expect(res.statusCode).toBe(200);
    return z;
}

async function civilian(h: H, email: string): Promise<Civilian> {
    const res = await h.app.inject({
        method: 'POST',
        url: '/civilians',
        payload: { email, zipCode: '96761' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
}

test('health', async () => {
    const res = await harness().app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ service: 'api', ok: true });
});

describe('civilians', () => {
    test('creates with a lowercased email and a number', async () => {
        const h = harness();
        const c = await civilian(h, 'Kai@Example.com');
        expect(c).toMatchObject({ email: 'kai@example.com', number: 1, civilianAreaId: null });
    });

    test('rejects malformed input and duplicates', async () => {
        const h = harness();
        await civilian(h, 'kai@example.com');
        const codes = await Promise.all(
            [
                { email: 'kai@example', zipCode: '96761' },
                { email: 'kai@example.com', zipCode: '9676' },
                { email: 'KAI@example.com', zipCode: '96761' },
            ].map(
                async (payload) =>
                    (await h.app.inject({ method: 'POST', url: '/civilians', payload })).statusCode,
            ),
        );
        expect(codes).toEqual([400, 400, 409]);
    });

    test('joining an area files the civilian under its zone', async () => {
        const h = harness();
        const z = await zoneWithGeography(h);
        const c = await civilian(h, 'kai@example.com');
        const res = await h.app.inject({
            method: 'PATCH',
            url: `/v1/civilians/${c.id}`,
            payload: { civilianAreaId: 'area-kahoma' },
        });
        expect(res.json()).toMatchObject({ zoneId: z.id, civilianAreaId: 'area-kahoma' });
        const list = await h.app.inject({
            method: 'GET',
            url: `/v1/watch-zones/${z.id}/civilians`,
        });
        expect(list.json<Civilian[]>().map((x) => x.id)).toEqual([c.id]);
    });
});

describe('watch zones and roads', () => {
    test('a zone from a center and radius gets a ring, centroid and area', async () => {
        const h = harness();
        const res = await h.app.inject({
            method: 'POST',
            url: '/v1/watch-zones',
            payload: { name: 'Here', center: CENTER, radiusM: 1000 },
        });
        const z = res.json<WatchZone>();
        expect(z.boundary).toHaveLength(32);
        expect(z.center.lat).toBeCloseTo(CENTER.lat, 4);
        expect(z.areaHa).toBeGreaterThan(300);
        expect(z.areaHa).toBeLessThan(320);
    });

    test('a road named loosely is blocked on every segment of that name', async () => {
        const h = harness();
        const z = await zoneWithGeography(h);
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/road-observations`,
            payload: {
                roadName: 'ridge road',
                state: 'blocked',
                source: 'responder',
                reportedBy: 'responder:2',
                note: 'tree down',
                location: null,
            },
        });
        expect(res.statusCode).toBe(201);
        const obs = res.json<RoadObservation[]>();
        expect(obs.map((o) => o.roadId)).toEqual(['r-ridge', 'r-ridge-2']);
        expect(obs[0]).toMatchObject({ previousState: 'open', state: 'blocked' });
        const ctx = (
            await h.app.inject({ method: 'GET', url: `/v1/watch-zones/${z.id}/planner-context` })
        ).json<PlannerContext>();
        expect(ctx.roads.filter((r) => r.state === 'blocked').map((r) => r.id)).toEqual([
            'r-ridge',
            'r-ridge-2',
        ]);
    });

    test('a partial name matches its road; unknown and ambiguous names list candidates', async () => {
        const h = harness();
        const z = await zoneWithGeography(h);
        const post = (roadName: string) =>
            h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/road-observations`,
                payload: {
                    roadName,
                    state: 'uncertain',
                    source: 'civilian',
                    reportedBy: 'civilian:1',
                    note: null,
                    location: null,
                },
            });
        expect((await post('Highway 30')).json<RoadObservation[]>()[0]!.roadId).toBe('r-hwy');
        const missing = await post('Kai Rd');
        expect(missing.statusCode).toBe(404);
        expect(missing.json().candidates.length).toBeGreaterThan(0);
        const ambiguous = await post('Front');
        expect(ambiguous.statusCode).toBe(409);
        expect(
            ambiguous
                .json()
                .candidates.map((c: { id: string }) => c.id)
                .toSorted(),
        ).toEqual(['r-front', 'r-front-n']);
    });

    test('geography keeps reported road states when replaced', async () => {
        const h = harness();
        const z = await zoneWithGeography(h);
        await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/road-observations`,
            payload: {
                roadId: 'r-hwy',
                state: 'blocked',
                source: 'operator',
                reportedBy: 'op',
                note: null,
                location: null,
            },
        });
        await h.app.inject({
            method: 'PUT',
            url: `/v1/watch-zones/${z.id}/geography`,
            payload: GEOGRAPHY,
        });
        const roads = (
            await h.app.inject({ method: 'GET', url: `/v1/watch-zones/${z.id}/roads` })
        ).json<{ id: string; state: string }[]>();
        expect(roads.find((r) => r.id === 'r-hwy')!.state).toBe('blocked');
    });
});

const frame = (center: { lat: number; lng: number }, confidence: number) => ({
    type: 'detections',
    droneId: 'd1',
    frameId: 7,
    capturedAt: '2026-10-03T12:00:00Z',
    scenarioTime: '2023-08-08T15:10:00-10:00',
    pose: { lat: 0, lng: 0, altM: 100, headingDeg: 0, pitchDeg: -90 },
    camera: { widthPx: 640, heightPx: 480, hfovDeg: 80 },
    detector: 'yolo',
    detections: [
        {
            id: 'region-1',
            risk: 'on_fire',
            confidence,
            bboxPx: [0, 0, 10, 10],
            ground: square(center, 0.0005),
            center,
            areaM2: 1000,
        },
    ],
});

describe('detections', () => {
    test('files detections under the zone containing them and refines repeats', async () => {
        const h = harness({ ingest: 'ik' });
        const z = await zone(h);
        const post = (payload: unknown, key = 'ik') =>
            h.app.inject({
                method: 'POST',
                url: '/v1/detections',
                payload,
                headers: { authorization: `Bearer ${key}` },
            });
        expect((await post(frame(CENTER, 0.5), 'wrong')).statusCode).toBe(401);
        expect((await post(frame(CENTER, 0.5))).json()).toEqual({ accepted: 1, dropped: 0 });
        expect((await post(frame({ lat: 0, lng: 0 }, 0.5))).json()).toEqual({
            accepted: 0,
            dropped: 1,
        });
        await post(frame(CENTER, 0.8));
        const list = (
            await h.app.inject({ method: 'GET', url: `/v1/watch-zones/${z.id}/detections` })
        ).json<DetectionRecord[]>();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            id: 'd1:region-1',
            confidence: 0.8,
            verification: 'unverified',
            source: 'drone',
        });
    });

    test('confirming a detection files it as a risk zone in the planner context', async () => {
        const h = harness();
        const z = await zone(h);
        const sim = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/detections/simulated`,
            payload: {
                center: CENTER,
                radiusM: 120,
                risk: 'on_fire',
                confidence: 0.6,
                requestedBy: 'ember',
            },
        });
        const d = sim.json<DetectionRecord>();
        expect(d).toMatchObject({ source: 'simulated', droneId: 'simulation' });
        let ctx = (
            await h.app.inject({ method: 'GET', url: `/v1/watch-zones/${z.id}/planner-context` })
        ).json<PlannerContext>();
        expect(ctx.detections.map((x) => x.id)).toEqual([d.id]);
        await h.app.inject({
            method: 'PATCH',
            url: `/v1/detections/${d.id}`,
            payload: { verification: 'confirmed', by: 'ember' },
        });
        ctx = (
            await h.app.inject({ method: 'GET', url: `/v1/watch-zones/${z.id}/planner-context` })
        ).json<PlannerContext>();
        expect(ctx.detections).toEqual([]);
        expect(ctx.riskZones).toHaveLength(1);
        expect(ctx.riskZones[0]).toMatchObject({ risk: 'on_fire', confidence: 0.6 });
        const del = (id: string) =>
            h.app.inject({ method: 'DELETE', url: `/v1/watch-zones/${z.id}/risk-zones/${id}` });
        expect((await del(ctx.riskZones[0]!.id)).statusCode).toBe(204);
        expect((await del(ctx.riskZones[0]!.id)).statusCode).toBe(404);
        expect(ctx.weather?.windSpeedMps).toBe(17);
    });
});

const edgeServer = (id: string, lat: number) => ({
    edgeServerId: id,
    url: `http://${id}.local:8070`,
    name: id,
    location: { lat, lng: CENTER.lng },
    connectivityRadiusM: 1000,
});

describe('scans', () => {
    test('no edge servers is a conflict', async () => {
        const h = harness();
        const z = await zone(h);
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/scans`,
            payload: { purpose: 'surveillance', reason: 'test', requestedBy: 'ember' },
        });
        expect(res.statusCode).toBe(409);
    });

    test('a verification scan maps a circle with the edge servers that reach it', async () => {
        const h = harness();
        const z = await zone(h);
        for (const e of [
            edgeServer('edge-1', CENTER.lat),
            edgeServer('edge-far', CENTER.lat + 0.1),
        ]) {
            expect(
                (
                    await h.app.inject({
                        method: 'POST',
                        url: `/v1/watch-zones/${z.id}/edge-servers`,
                        payload: e,
                    })
                ).statusCode,
            ).toBe(201);
        }
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/scans`,
            payload: {
                purpose: 'verification',
                reason: 'confidence 0.55',
                requestedBy: 'ember',
                focus: { center: CENTER, radiusM: 300 },
            },
        });
        const scan = res.json<Scan>();
        expect(scan).toMatchObject({
            state: 'mapping',
            edgeServerIds: ['edge-1'],
            purpose: 'verification',
        });
        const task = h.edge.tasks[0]!;
        expect(task.kind).toBe('start_mapping');
        expect(task.kind === 'start_mapping' && task.boundary).toHaveLength(32);
        const stop = await h.app.inject({
            method: 'POST',
            url: `/v1/scans/${scan.runId}/stop`,
            payload: { requestedBy: 'ember', reason: 'verified' },
        });
        expect(stop.json<Scan>().state).toBe('stopped');
        expect(h.edge.tasks[1]!.kind).toBe('stop_mapping');
    });

    test('an unreachable edge-manager records a failed scan', async () => {
        const h = harness();
        const z = await zone(h);
        await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/edge-servers`,
            payload: edgeServer('edge-1', CENTER.lat),
        });
        h.edge.fail = new Error('connect ECONNREFUSED');
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/scans`,
            payload: { purpose: 'surveillance', reason: 'risk high', requestedBy: 'ember' },
        });
        expect(res.json<Scan>()).toMatchObject({ state: 'failed', error: 'connect ECONNREFUSED' });
    });
});

describe('planner jobs', () => {
    test('enqueue, status, result; the incident tracks its latest two plans', async () => {
        const h = harness({ planner: 'pk' });
        const z = await zone(h);
        const incident = (
            await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/incidents`,
                payload: {
                    state: 'active',
                    domain: 'emergency',
                    title: 'Fire',
                    summary: '',
                    location: CENTER,
                    detectionIds: [],
                },
            })
        ).json<Incident>();
        expect(incident.number).toBe(1);
        const planner = { authorization: 'Bearer pk' };
        const jobs: string[] = [];
        for (let i = 0; i < 2; i++) {
            const res = await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/planner-jobs`,
                payload: {
                    requestedBy: 'ember',
                    reason: 'fire confirmed',
                    incidentId: incident.id,
                    options: { horizonMin: 120 },
                },
            });
            expect(res.statusCode).toBe(202);
            const job = res.json<PlannerJob>();
            jobs.push(job.jobId);
            expect(h.queue.jobs.at(-1)).toMatchObject({
                jobId: job.jobId,
                zoneId: z.id,
                options: { horizonMin: 120 },
            });
            expect(
                (
                    await h.app.inject({
                        method: 'POST',
                        url: `/v1/planner/jobs/${job.jobId}/status`,
                        payload: {
                            jobId: job.jobId,
                            zoneId: z.id,
                            state: 'planning',
                            at: 'now',
                            message: null,
                        },
                    })
                ).statusCode,
            ).toBe(401);
            await h.app.inject({
                method: 'POST',
                url: `/v1/planner/jobs/${job.jobId}/status`,
                headers: planner,
                payload: {
                    jobId: job.jobId,
                    zoneId: z.id,
                    state: 'planning',
                    at: 'now',
                    message: null,
                },
            });
            h.advance(1000);
            const result = await h.app.inject({
                method: 'POST',
                url: `/v1/planner/jobs/${job.jobId}/result`,
                headers: planner,
                payload: plannerResult(job.jobId, z.id),
            });
            expect(result.statusCode).toBe(200);
        }
        const latest = (
            await h.app.inject({
                method: 'GET',
                url: `/v1/watch-zones/${z.id}/planner-jobs/latest`,
            })
        ).json();
        expect(latest.job).toMatchObject({ jobId: jobs[1], state: 'succeeded' });
        expect(latest.result.attackZones).toHaveLength(2);
        const view = (
            await h.app.inject({ method: 'GET', url: `/v1/incidents/${incident.id}` })
        ).json();
        expect(view.incident).toMatchObject({ latestJobId: jobs[1], previousJobId: jobs[0] });
        expect(view.events.map((e: { kind: string }) => e.kind)).toEqual(['plan', 'plan']);
    });

    test('a result for another job is refused', async () => {
        const h = harness();
        const z = await zone(h);
        const job = (
            await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/planner-jobs`,
                payload: { requestedBy: 'ember' },
            })
        ).json<PlannerJob>();
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/planner/jobs/${job.jobId}/result`,
            payload: plannerResult('other', z.id),
        });
        expect(res.statusCode).toBe(400);
    });
});

async function approvalSetup(keys = { operator: 'ok', agent: 'ak' }) {
    const h = harness(keys);
    const agent = { authorization: 'Bearer ak' };
    const operator = { authorization: 'Bearer ok' };
    const z = (
        await h.app.inject({
            method: 'POST',
            url: '/v1/watch-zones',
            headers: agent,
            payload: { name: 'Lahaina', boundary: square(CENTER) },
        })
    ).json<WatchZone>();
    const a = await civilian(h, 'a@example.com');
    const b = await civilian(h, 'b@example.com');
    const res = await h.app.inject({
        method: 'POST',
        url: '/v1/approvals',
        headers: agent,
        payload: {
            zoneId: z.id,
            reason: 'Kahoma reached in 42 min',
            draftedBy: 'ember',
            draft: {
                kind: 'civilian_alert',
                jobId: 'job-1',
                civilianAreaId: 'area-kahoma',
                severity: 'immediate',
                recipients: [
                    { civilianId: a.id, body: 'Leave now via Highway 30 north.' },
                    {
                        civilianId: b.id,
                        body: 'Leave now via Highway 30 north. Bring the dogs.',
                    },
                ],
                mapUrl: null,
            },
        },
    });
    expect(res.statusCode).toBe(201);
    return { h, agent, operator, a, b, approval: res.json<Approval>() };
}

describe('approvals and civilian messages', () => {
    test('only the operator key decides, and only with the confirmation code', async () => {
        const { h, agent, operator, approval } = await approvalSetup();
        const decide = (headers: Record<string, string>, code: string) =>
            h.app.inject({
                method: 'POST',
                url: `/v1/approvals/${approval.id}/decision`,
                headers,
                payload: {
                    decision: 'approve',
                    operator: 'K. Akana',
                    via: 'dashboard',
                    confirmationCode: code,
                },
            });
        expect(approval.confirmationCode).toMatch(/^[A-Z2-9]{4}$/);
        expect((await decide(agent, approval.confirmationCode)).statusCode).toBe(401);
        expect((await decide(operator, 'ZZZZ')).statusCode).toBe(409);
        const ok = await decide(operator, approval.confirmationCode.toLowerCase());
        expect(ok.json<Approval>()).toMatchObject({ state: 'approved', decidedBy: 'K. Akana' });
        expect((await decide(operator, approval.confirmationCode)).statusCode).toBe(409);
    });

    test('outbound alerts need an approved approval with the exact text, once per civilian', async () => {
        const { h, agent, operator, a, b, approval } = await approvalSetup();
        const send = (
            civilianId: string,
            body: string,
            extra: object = { approvalId: approval.id },
        ) =>
            h.app.inject({
                method: 'POST',
                url: '/v1/civilian-messages',
                headers: agent,
                payload: { civilianId, channel: 'imessage', body, ...extra },
            });
        expect((await send(a.id, 'Leave now via Highway 30 north.', {})).statusCode).toBe(403);
        expect((await send(a.id, 'Leave now via Highway 30 north.')).statusCode).toBe(403);
        await h.app.inject({
            method: 'POST',
            url: `/v1/approvals/${approval.id}/decision`,
            headers: operator,
            payload: {
                decision: 'approve',
                operator: 'op',
                via: 'asi1',
                confirmationCode: approval.confirmationCode,
            },
        });
        expect((await send(a.id, 'Leave now via Highway 30 south.')).statusCode).toBe(403);
        expect((await send(a.id, 'Leave now via Highway 30 north.')).statusCode).toBe(201);
        expect((await send(a.id, 'Leave now via Highway 30 north.')).statusCode).toBe(409);
        expect(
            (await send(b.id, 'Leave now via Highway 30 north. Bring the dogs.')).statusCode,
        ).toBe(201);
        const after = (
            await h.app.inject({
                method: 'GET',
                url: `/v1/approvals/${approval.id}`,
                headers: agent,
            })
        ).json<Approval>();
        expect(after.state).toBe('sent');
    });

    test('a reply needs a recent inbound message from the same civilian', async () => {
        const { h, agent, a, b } = await approvalSetup();
        const inbound = await h.app.inject({
            method: 'POST',
            url: '/v1/civilian-messages/inbound',
            headers: agent,
            payload: {
                handle: 'A@example.com',
                channel: 'imessage',
                body: 'Do I need to evacuate?',
                attachments: [],
            },
        });
        expect(inbound.statusCode).toBe(201);
        const id = inbound.json().message.id;
        const reply = (civilianId: string) =>
            h.app.inject({
                method: 'POST',
                url: '/v1/civilian-messages',
                headers: agent,
                payload: { civilianId, channel: 'imessage', body: 'Yes.', inReplyTo: id },
            });
        expect((await reply(b.id)).statusCode).toBe(403);
        expect((await reply(a.id)).statusCode).toBe(201);
        h.advance(25 * 60 * 60 * 1000);
        expect((await reply(a.id)).statusCode).toBe(403);
        const unknown = await h.app.inject({
            method: 'POST',
            url: '/v1/civilian-messages/inbound',
            headers: agent,
            payload: {
                handle: 'nobody@example.com',
                channel: 'imessage',
                body: 'hi',
                attachments: [],
            },
        });
        expect(unknown.statusCode).toBe(404);
    });
});

async function responderSetup() {
    const h = harness();
    const z = await zoneWithGeography(h);
    const responders: Responder[] = [];
    for (const [name, stationId] of [
        ['Engine 1', null],
        ['Engine 3', 'station-1'],
        ['Crew 7', 'station-1'],
    ] as const) {
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/responders`,
            payload: {
                name,
                role: 'engine',
                capabilities: ['water'],
                stationId,
                location: CENTER,
            },
        });
        responders.push(res.json());
    }
    const incident = (
        await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/incidents`,
            payload: {
                state: 'active',
                domain: 'emergency',
                title: 'Fire',
                summary: '',
                location: CENTER,
                detectionIds: [],
            },
        })
    ).json<Incident>();
    const plan = async (result: (jobId: string) => PlannerResult) => {
        const job = (
            await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/planner-jobs`,
                payload: { requestedBy: 'ember', incidentId: incident.id },
            })
        ).json<PlannerJob>();
        await h.app.inject({
            method: 'POST',
            url: `/v1/planner/jobs/${job.jobId}/result`,
            payload: result(job.jobId),
        });
        return job.jobId;
    };
    return { h, z, responders, incident, plan };
}

describe('responders', () => {
    test('assigns by rank from the approach station and writes instructions from the plan', async () => {
        const { h, z, responders, incident, plan } = await responderSetup();
        const jobId = await plan((id) => plannerResult(id, z.id));
        const res = await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/assignments`,
            payload: { jobId, incidentId: incident.id },
        });
        const out = res.json<AssignRespondersResult>();
        expect(out.assignments.map((a) => [a.attackZoneLabel, a.responderId])).toEqual([
            ['A', responders[1]!.id],
            ['B', responders[2]!.id],
        ]);
        expect(out.assignments[0]!.instructions).toBe(
            'Incident #1. Deploy to Attack Zone A (drop site on Ridge Rd). Approach from the southeast. Projected fire arrival ≈ 28 min. Direct attack on the fire edge. Protects Kahoma.',
        );
        const list = (
            await h.app.inject({ method: 'GET', url: `/v1/watch-zones/${z.id}/responders` })
        ).json<Responder[]>();
        expect(list.map((r) => r.availability)).toEqual(['available', 'assigned', 'assigned']);
    });

    test('a replan supersedes only crews whose approach or drop site changed', async () => {
        const { h, z, responders, incident, plan } = await responderSetup();
        const first = await plan((id) => plannerResult(id, z.id));
        await h.app.inject({
            method: 'POST',
            url: `/v1/watch-zones/${z.id}/assignments`,
            payload: { jobId: first, incidentId: incident.id },
        });
        const rerouted = attackZone(1, {
            approach: {
                stationId: 'station-1',
                path: [CENTER],
                roadIds: ['r-hwy', 'r-front'],
                etaMin: 14,
                arrivesFromDeg: 200,
            },
        });
        const second = await plan((id) =>
            plannerResult(id, z.id, { attackZones: [rerouted, attackZone(2)] }),
        );
        const out = (
            await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/assignments`,
                payload: { jobId: second, incidentId: incident.id },
            })
        ).json<AssignRespondersResult>();
        expect(out.superseded.map((a) => [a.attackZoneId, a.responderId])).toEqual([
            ['attack-1', responders[1]!.id],
        ]);
        const zoneA = out.assignments.find((a) => a.attackZoneId === 'attack-1')!;
        expect(zoneA.instructions).toContain('Approach from the south.');
        expect(zoneA.jobId).toBe(second);
        const zoneB = out.assignments.find((a) => a.attackZoneId === 'attack-2')!;
        expect(zoneB).toMatchObject({ responderId: responders[2]!.id, jobId: second });
    });

    test('a paired phone gets its zone bundle, its own messages and a 304 when unchanged', async () => {
        const { h, z, responders, plan } = await responderSetup();
        await plan((id) => plannerResult(id, z.id));
        const code = (
            await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/responder-pairing-codes`,
                payload: { responderId: responders[0]!.id },
            })
        ).json<ResponderPairingCode>();
        const session = (
            await h.app.inject({
                method: 'POST',
                url: '/v1/responders/pair',
                payload: { token: code.token, deviceName: 'Pixel', platform: 'android' },
            })
        ).json<ResponderSession>();
        expect(session.responderId).toBe(responders[0]!.id);
        expect(
            (
                await h.app.inject({
                    method: 'POST',
                    url: '/v1/responders/pair',
                    payload: { token: code.token, deviceName: 'x', platform: 'ios' },
                })
            ).statusCode,
        ).toBe(401);
        for (const responderId of [responders[0]!.id, responders[1]!.id, null]) {
            await h.app.inject({
                method: 'POST',
                url: `/v1/watch-zones/${z.id}/responder-messages`,
                payload: {
                    responderId,
                    kind: 'directive',
                    priority: 'urgent',
                    title: 't',
                    body: String(responderId),
                    from: 'ember',
                    location: null,
                },
            });
        }
        const headers = { authorization: `Bearer ${session.sessionToken}` };
        const res = await h.app.inject({
            method: 'GET',
            url: `/v1/responders/zones/${z.id}/bundle`,
            headers,
        });
        const bundle = res.json<ResponderZoneBundle>();
        expect(bundle.plan?.attackZones).toHaveLength(2);
        expect(bundle.messages.map((m) => m.responderId).toSorted()).toEqual(
            [responders[0]!.id, null].toSorted(),
        );
        expect(res.headers.etag).toBe(`"${bundle.version}"`);
        const again = await h.app.inject({
            method: 'GET',
            url: `/v1/responders/zones/${z.id}/bundle`,
            headers: { ...headers, 'if-none-match': `"${bundle.version}"` },
        });
        expect(again.statusCode).toBe(304);
        expect(
            (await h.app.inject({ method: 'GET', url: `/v1/responders/zones/${z.id}/bundle` }))
                .statusCode,
        ).toBe(401);
    });
});
