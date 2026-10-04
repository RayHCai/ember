import { expect, test } from 'vitest';
import type {
    Approval,
    Civilian,
    CreateApprovalRequest,
    Incident,
    PlannerJob,
    PlannerResult,
    ResponderAssignment,
    RoadObservation,
    SendResponderMessageRequest,
    WatchZone,
    WatchZoneId,
} from '@ember/contracts';
import type { ApiClient } from './api.js';
import { handleRoadReport } from './playbooks/response.js';
import { C, context, GEO, result, route, zone } from './testing/fixtures.js';

const ZONE = { id: 'z1', name: 'Lahaina' } as WatchZone;

const job = (jobId: string, state: PlannerJob['state']) =>
    ({ jobId, state, updatedAt: '', requestedAt: '' }) as PlannerJob;

/** Just enough api: one incident on plan j1, two crews, and a planner that returns `next`. */
function fakeApi(next: PlannerResult) {
    const roads = GEO.roads.map((r) => ({ ...r }));
    const plans = new Map<string, PlannerResult>([['j1', result('j1')]]);
    const incident = {
        id: 'i1',
        number: 14,
        state: 'active',
        latestJobId: 'j1',
        zoneId: 'z1',
    } as Incident;
    let assignments: ResponderAssignment[] = ['attack-1', 'attack-2'].map((attackZoneId, i) => ({
        id: `a${i + 1}`,
        responderId: `r${i + 1}`,
        zoneId: 'z1' as WatchZoneId,
        incidentId: 'i1',
        jobId: 'j1',
        attackZoneId,
        attackZoneLabel: 'AB'[i]!,
        dropSite: C,
        instructions: '',
        state: 'active',
        createdAt: '',
        updatedAt: '',
    }));
    const sent: SendResponderMessageRequest[] = [];
    const approvals: Approval[] = [];
    const civilians = [
        { id: 'c4', number: 4, civilianAreaId: 'area-bypass', notes: null } as Civilian,
    ];
    const api: Partial<ApiClient> = {
        observeRoad: async (_z, body) => {
            const hit = roads.filter(
                (r) => r.name === 'Ridge Rd' && /ridge/i.test(body.roadName ?? ''),
            );
            return hit.map((r) => {
                const o = {
                    id: `o-${r.id}`,
                    roadId: r.id,
                    roadName: r.name,
                    previousState: r.state,
                    state: body.state,
                } as RoadObservation;
                r.state = body.state;
                return o;
            });
        },
        incidents: async () => [incident],
        plan: async (jobId) => ({ job: job(jobId, 'succeeded'), result: plans.get(jobId) ?? null }),
        addIncidentEvent: async () => ({}) as never,
        enqueuePlan: async () => {
            plans.set(next.jobId, next);
            incident.previousJobId = incident.latestJobId;
            incident.latestJobId = next.jobId;
            return job(next.jobId, 'queued');
        },
        geography: async () => ({ terrain: null, stations: [], ...GEO, roads }),
        assignments: async () => assignments.filter((a) => a.state === 'active'),
        assign: async (_z, body) => {
            const r = plans.get(body.jobId)!;
            const superseded: ResponderAssignment[] = [];
            const kept: ResponderAssignment[] = [];
            for (const a of assignments.filter((x) => x.state === 'active')) {
                const was = plans.get(a.jobId)!.attackZones.find((z) => z.id === a.attackZoneId)!;
                const now = r.attackZones.find((z) => z.id === a.attackZoneId);
                if (now && now.approach?.roadIds.join() === was.approach?.roadIds.join())
                    kept.push({ ...a, jobId: r.jobId });
                else superseded.push({ ...a, state: 'superseded' });
            }
            const created = superseded.map((s) => ({
                ...s,
                id: `${s.id}-new`,
                jobId: r.jobId,
                state: 'active' as const,
            }));
            assignments = [...kept, ...superseded, ...created];
            return { assignments: [...kept, ...created], superseded, unassigned: [] };
        },
        sendResponderMessage: async (_z, body) => {
            sent.push(body);
            return {} as never;
        },
        approvals: async () => approvals,
        civilians: async () => civilians,
        createApproval: async (body: CreateApprovalRequest) => {
            const a = {
                ...body,
                id: `ap${approvals.length + 1}`,
                number: approvals.length + 1,
                state: 'pending',
            } as Approval;
            approvals.push(a);
            return a;
        },
    };
    return { api, sent, approvals, incident };
}

test('a blocked road replans and reaches only the crews and civilians it changed', async () => {
    const next = result('j2', {
        attackZones: [zone(1, ['r-bypass']), zone(2, ['r-hwy', 'r-front'])],
        evacuationRoutes: [route('area-bypass', ['r-front'], 'sz-south')],
    });
    const fake = fakeApi(next);
    const ctx = context(fake.api);
    const replan = await handleRoadReport(ctx, ZONE, {
        roadName: 'Ridge Road',
        state: 'blocked',
        source: 'responder',
        reportedBy: 'responder:r2',
        reporterLabel: 'Responder 2',
        note: 'tree down',
    });

    expect(replan.usedBy).toEqual({ attackZones: ['attack-2'], evacuationRoutes: [] });
    expect([replan.oldJobId, replan.newJobId]).toEqual(['j1', 'j2']);
    expect(replan.diff!.attackZones.find((z) => z.id === 'attack-2')!.change).toBe('rerouted');
    expect(fake.sent.map((m) => [m.responderId, m.kind])).toEqual([['r2', 'directive']]);
    expect(fake.approvals).toHaveLength(1);
    const draft = fake.approvals[0]!.draft;
    expect(draft.kind === 'civilian_alert' && draft.recipients[0]!.body).toContain(
        'Ember UPDATE for Bypass Homes',
    );
    expect(draft.kind === 'civilian_alert' && draft.recipients[0]!.body).toContain(
        'via Front St toward Puamana Park',
    );

    const decision = await ctx.memory.decision(replan.decisionId);
    expect(decision).toMatchObject({ kind: 'replan', incidentId: 'i1', domain: 'emergency' });
    expect(decision!.reason).toContain('responder report from Responder 2: "tree down"');
    expect(decision!.inputs.map((i) => i.kind)).toEqual([
        'road_observation',
        'planner_job',
        'planner_job',
    ]);
});

test('a road no plan uses is recorded without replanning', async () => {
    const fake = fakeApi(result('j2'));
    const plain = result('j1', {
        attackZones: [zone(1, ['r-bypass'])],
        evacuationRoutes: [route('area-bypass', ['r-hwy'])],
    });
    fake.api.plan = async (jobId) => ({
        job: job(jobId, 'succeeded'),
        result: jobId === 'j1' ? plain : null,
    });
    const ctx = context(fake.api);
    const replan = await handleRoadReport(ctx, ZONE, {
        roadName: 'Ridge Rd',
        state: 'blocked',
        source: 'operator',
        reportedBy: 'op',
        note: null,
    });
    expect(replan.newJobId).toBeNull();
    expect(fake.sent).toEqual([]);
    expect((await ctx.memory.decision(replan.decisionId))!.kind).toBe('road_state');
});
