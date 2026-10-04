import type {
    Approval,
    AssignRespondersResult,
    DetectionRecord,
    Incident,
    PlannerJobView,
    PlannerResult,
    ResponderAssignment,
    WatchZone,
} from '@ember/contracts';
import { ApiError } from '../api.js';
import { handleOf } from '../channels.js';
import { decide, describeError, EMBER, geography, runPlanner, type Ctx } from '../context.js';
import { diffPlans, type PlanDiff } from '../diff.js';
import { usesOfRoads, type Geography } from '../views.js';
import { alertMap } from '../map/alertMap.js';
import type { MapImage } from '../map/imagery.js';
import { draftCivilianAlert } from './alerts.js';

const OPEN_STATES = new Set<Incident['state']>(['suspected', 'verifying', 'active']);
const SAME_INCIDENT_M = 2000;

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const rad = Math.PI / 180;
    const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    return Math.hypot(x, (b.lat - a.lat) * rad) * 6_371_008.8;
}

export async function openIncidents(ctx: Ctx, zoneId: string): Promise<Incident[]> {
    return (await ctx.api.incidents(zoneId)).filter((i) => OPEN_STATES.has(i.state));
}

/**
 * A credible fire: confirm its detections, open (or join) an incident, plan, then coordinate.
 * Returns the incident; planning failures are logged on it rather than thrown.
 */
export async function escalate(
    ctx: Ctx,
    zone: WatchZone,
    detections: DetectionRecord[],
    reason: string,
    confidence: number,
): Promise<Incident> {
    for (const d of detections) {
        if (d.verification !== 'confirmed') await ctx.api.verifyDetection(d.id, 'confirmed', EMBER);
    }
    const lead = detections[0]!;
    const ids = detections.map((d) => d.id);
    const near = (await openIncidents(ctx, zone.id)).find(
        (i) => i.location && metres(i.location, lead.center) <= SAME_INCIDENT_M,
    );
    const incident = near
        ? await ctx.api.updateIncident(near.id, {
              state: 'active',
              domain: 'emergency',
              detectionIds: [...new Set([...near.detectionIds, ...ids])],
          })
        : await ctx.api.createIncident(zone.id, {
              state: 'active',
              domain: 'emergency',
              title: `${lead.source === 'simulated' ? 'Simulated fire' : 'Fire'} in ${zone.name}`,
              summary: reason,
              location: lead.center,
              detectionIds: ids,
          });
    await ctx.api.addIncidentEvent(incident.id, {
        kind: 'verification',
        summary: `Confirmed ${ids.length} detection(s): ${reason}`,
        refs: Object.fromEntries(ids.map((id, i) => [`detection${i + 1}`, id])),
        actor: EMBER,
    });
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: incident.id,
        domain: 'emergency',
        kind: 'escalate',
        summary: `Escalated to Emergency Response: Incident #${incident.number}`,
        reason,
        inputs: detections.map((d) => ({
            kind: 'detection' as const,
            id: d.id,
            note: `${d.source}, ${d.risk}, confidence ${d.confidence}`,
        })),
        confidence,
        actions: [
            near ? `joined Incident #${incident.number}` : `opened Incident #${incident.number}`,
        ],
    });
    try {
        const view = await runPlanner(ctx, zone.id, {
            reason: `Incident #${incident.number}: ${reason}`,
            incidentId: incident.id,
        });
        await coordinate(ctx, zone, incident, view, { cause: 'escalation' });
    } catch (err) {
        await ctx.api.addIncidentEvent(incident.id, {
            kind: 'note',
            summary: `Planning failed: ${describeError(err)}`,
            refs: {},
            actor: EMBER,
        });
        ctx.log.error(
            { err: describeError(err), incident: incident.number },
            'escalation planning failed',
        );
    }
    return (await ctx.api.incident(incident.id)).incident;
}

export type Coordination = {
    assignment: AssignRespondersResult;
    messagedResponders: string[];
    approvals: Approval[];
};

async function notifyResponders(
    ctx: Ctx,
    zone: WatchZone,
    incident: Incident,
    created: ResponderAssignment[],
    superseded: ResponderAssignment[],
): Promise<string[]> {
    const messaged: string[] = [];
    for (const a of created) {
        await ctx.api.sendResponderMessage(zone.id, {
            responderId: a.responderId,
            kind: 'directive',
            priority: 'critical',
            title: `Incident #${incident.number}: Attack Zone ${a.attackZoneLabel}`,
            body: a.instructions,
            from: EMBER,
            location: a.dropSite,
        });
        messaged.push(a.responderId);
    }
    const reassigned = new Set(created.map((a) => a.responderId));
    for (const a of superseded.filter((s) => !reassigned.has(s.responderId))) {
        await ctx.api.sendResponderMessage(zone.id, {
            responderId: a.responderId,
            kind: 'update',
            priority: 'urgent',
            title: `Incident #${incident.number}: Attack Zone ${a.attackZoneLabel} cancelled`,
            body: `The plan changed and Attack Zone ${a.attackZoneLabel} is no longer assigned to you. Hold for new orders.`,
            from: EMBER,
            location: null,
        });
        messaged.push(a.responderId);
    }
    return messaged;
}

/** Assigns through the api and messages only responders whose orders are new or withdrawn. */
async function assignAndNotify(
    ctx: Ctx,
    zone: WatchZone,
    incident: Incident,
    jobId: string,
): Promise<{
    assignment: AssignRespondersResult;
    created: ResponderAssignment[];
    messaged: string[];
}> {
    const before = new Set(
        (await ctx.api.assignments(zone.id, { incidentId: incident.id, state: 'active' })).map(
            (a) => a.id,
        ),
    );
    const assignment = await ctx.api.assign(zone.id, { jobId, incidentId: incident.id });
    const created = assignment.assignments.filter((a) => !before.has(a.id));
    const messaged = await notifyResponders(ctx, zone, incident, created, assignment.superseded);
    return { assignment, created, messaged };
}

/**
 * Acts on a plan: responders to attack zones (the api's ordinary assignment), messages to the
 * responders whose orders are new, and civilian alert drafts awaiting operator approval for the
 * given areas (every warned area when not given).
 */
export async function coordinate(
    ctx: Ctx,
    zone: WatchZone,
    incident: Incident,
    view: PlannerJobView,
    opts: { cause: string; areas?: string[] },
): Promise<Coordination> {
    const result = view.result!;
    const {
        assignment,
        created,
        messaged: messagedResponders,
    } = await assignAndNotify(ctx, zone, incident, result.jobId);
    const geo = await geography(ctx, zone.id);
    const warned = result.civilianImpacts
        .filter((i) => i.severity === 'immediate' || i.severity === 'warning')
        .map((i) => i.civilianAreaId);
    const areas = opts.areas ? warned.filter((a) => opts.areas!.includes(a)) : warned;
    const approvals: Approval[] = [];
    for (const areaId of areas) {
        const approval = await draftCivilianAlert(ctx, zone, incident, result, geo, areaId, {
            update: opts.cause === 'replan',
        });
        if (approval) approvals.push(approval);
    }
    await ctx.api.addIncidentEvent(incident.id, {
        kind: 'alert',
        summary: `${assignment.assignments.length} crews on ${result.attackZones.length} attack zones; ${approvals.length} civilian alert draft(s) awaiting operator approval`,
        refs: { jobId: result.jobId },
        actor: EMBER,
    });
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: incident.id,
        domain: 'emergency',
        kind: 'coordinate',
        summary: `Coordinated Incident #${incident.number} on plan ${result.jobId.slice(0, 8)}: ${created.length} new crew orders, ${approvals.length} alert drafts`,
        reason: `${opts.cause}; ${warned.length} civilian area(s) at warning or worse; ${assignment.unassigned.length} attack zone(s) without a crew`,
        inputs: [
            {
                kind: 'planner_job',
                id: result.jobId,
                note: `${result.attackZones.length} attack zones`,
            },
            ...approvals.map((a) => ({
                kind: 'approval' as const,
                id: a.id,
                note: `approval ${a.number} pending`,
            })),
        ],
        confidence: 0.9,
        actions: [
            `POST /v1/watch-zones/${zone.id}/assignments`,
            ...messagedResponders.map((r) => `responder message -> ${r}`),
            ...approvals.map((a) => `approval ${a.number} drafted`),
        ],
    });
    return { assignment, messagedResponders, approvals };
}

/** Texts every approved civilian alert not yet sent. The api checks each against its approval. */
export async function sendApproved(ctx: Ctx): Promise<number> {
    let sent = 0;
    for (const approval of await ctx.api.approvals({ state: 'approved' })) {
        const draft = approval.draft;
        if (draft.kind !== 'civilian_alert') continue;
        let map: MapImage | null | undefined;
        let queued = 0;
        for (const r of draft.recipients) {
            try {
                const civilian = await ctx.api.civilian(r.civilianId);
                const message = await ctx.api.queueCivilianMessage({
                    civilianId: r.civilianId,
                    channel: 'imessage',
                    body: r.body,
                    approvalId: approval.id,
                    jobId: draft.jobId,
                });
                queued += 1;
                try {
                    await ctx.transport.send(handleOf(civilian), r.body);
                    await ctx.api.reportDelivery(message.id, 'sent');
                    sent += 1;
                } catch (err) {
                    await ctx.api.reportDelivery(message.id, 'failed', describeError(err));
                    continue;
                }
                // The map is drawn once per alert, from the plan the operator approved.
                if (map === undefined)
                    map = await alertMap(ctx, approval.zoneId, draft).catch(() => null);
                if (map) {
                    await ctx.transport
                        .sendImage(handleOf(civilian), map.data, map.mimeType)
                        .catch((err: unknown) =>
                            ctx.log.warn({ err: describeError(err) }, 'map image not delivered'),
                        );
                }
            } catch (err) {
                if (!(err instanceof ApiError && err.status === 409)) {
                    ctx.log.warn(
                        { err: describeError(err), approval: approval.number },
                        'alert not queued',
                    );
                }
            }
        }
        if (!queued) continue;
        await decide(ctx, {
            zoneId: approval.zoneId,
            incidentId: approval.incidentId,
            domain: 'civilian',
            kind: 'notify_civilians',
            summary: `Sent approved alert ${approval.number} to ${queued} civilian(s) in ${draft.civilianAreaId}`,
            reason: `operator ${approval.decidedBy} approved via ${approval.decidedVia}`,
            inputs: [{ kind: 'approval', id: approval.id, note: `approval ${approval.number}` }],
            confidence: 1,
            actions: [
                `${ctx.transport.name}: ${queued} text(s)`,
                ...(map ? [`map image (${map.generatedBy})`] : []),
            ],
        });
    }
    return sent;
}

export type RoadReport = {
    roadId?: string;
    roadName?: string;
    state: 'open' | 'blocked' | 'uncertain';
    source: 'responder' | 'civilian' | 'operator' | 'drone';
    reportedBy: string;
    /** How people know the reporter, e.g. "Responder 2"; defaults to `reportedBy`. */
    reporterLabel?: string;
    note: string | null;
};

export type Replan = {
    decisionId: string;
    zoneId: string;
    incidentId: string | null;
    roadIds: string[];
    roadName: string | null;
    state: RoadReport['state'];
    reportedBy: string;
    usedBy: { attackZones: string[]; evacuationRoutes: string[] };
    oldJobId: string | null;
    newJobId: string | null;
    diff: PlanDiff | null;
    notifiedResponders: string[];
    alertDrafts: number[];
    at: string;
};

/**
 * The closed loop: record the road, find every current plan that relies on it, replan, diff,
 * and notify only the people whose orders or routes changed.
 */
export async function handleRoadReport(
    ctx: Ctx,
    zone: WatchZone,
    report: RoadReport,
): Promise<Replan> {
    const observations = await ctx.api.observeRoad(zone.id, {
        ...(report.roadId ? { roadId: report.roadId } : {}),
        ...(report.roadName ? { roadName: report.roadName } : {}),
        state: report.state,
        source: report.source,
        reportedBy: report.reportedBy,
        note: report.note,
        location: null,
    });
    const label = report.reporterLabel ?? report.reportedBy;
    const roadIds = observations.map((o) => o.roadId);
    const roadName = observations[0]?.roadName ?? null;
    const incidents = await openIncidents(ctx, zone.id);
    const incident = incidents.find((i) => i.latestJobId) ?? incidents[0] ?? null;
    const current = incident?.latestJobId
        ? await ctx.api.plan(incident.latestJobId)
        : await ctx.api.latestPlan(zone.id);
    const old: PlannerResult | null = current?.result ?? null;
    const usedBy = old ? usesOfRoads(old, roadIds) : { attackZones: [], evacuationRoutes: [] };
    const changed = observations.some((o) => o.previousState !== o.state);
    const replan =
        changed &&
        (usedBy.attackZones.length > 0 ||
            usedBy.evacuationRoutes.length > 0 ||
            report.state === 'open');
    if (incident) {
        await ctx.api.addIncidentEvent(incident.id, {
            kind: 'road',
            summary: `${roadName ?? roadIds.join(', ')} reported ${report.state} by ${label}`,
            refs: Object.fromEntries(observations.map((o, i) => [`roadObservation${i + 1}`, o.id])),
            actor: report.reportedBy,
        });
    }

    let next: PlannerJobView | null = null;
    let diff: PlanDiff | null = null;
    let notifiedResponders: string[] = [];
    const alertDrafts: number[] = [];
    let geo: Geography | null = null;
    if (replan && old) {
        next = await runPlanner(ctx, zone.id, {
            reason: `${roadName ?? 'road'} ${report.state} (reported by ${label})`,
            incidentId: incident?.id ?? null,
        });
        geo = await geography(ctx, zone.id);
        diff = diffPlans(old, next.result!, geo);
        if (incident) {
            notifiedResponders = (await assignAndNotify(ctx, zone, incident, next.job.jobId))
                .messaged;
            const areas = diff.civilianAreas.map((a) => a.civilianAreaId);
            for (const areaId of areas) {
                const impact = next.result!.civilianImpacts.find(
                    (i) => i.civilianAreaId === areaId,
                );
                if (impact?.severity !== 'immediate' && impact?.severity !== 'warning') continue;
                const changes = diff.civilianAreas.find((a) => a.civilianAreaId === areaId)!.detail;
                const approval = await draftCivilianAlert(
                    ctx,
                    zone,
                    incident,
                    next.result!,
                    geo,
                    areaId,
                    {
                        update: true,
                        changes,
                    },
                );
                if (approval) alertDrafts.push(approval.number);
            }
        }
    }
    const decision = await decide(ctx, {
        zoneId: zone.id,
        incidentId: incident?.id ?? null,
        domain: 'emergency',
        kind: replan ? 'replan' : 'road_state',
        summary: replan
            ? `Replanned after ${roadName ?? 'a road'} was reported ${report.state}: ${diff?.attackZones.filter((z) => z.change !== 'unchanged').length ?? 0} attack zone(s) and ${diff?.civilianAreas.length ?? 0} civilian area(s) changed`
            : `Recorded ${roadName ?? 'road'} as ${report.state}; ${changed ? 'no current plan uses it' : 'no change'}`,
        reason: `${report.source} report from ${label}${report.note ? `: "${report.note}"` : ''}. Plan ${old?.jobId.slice(0, 8) ?? 'none'} used it for attack zones [${usedBy.attackZones.join(', ')}] and evacuation routes [${usedBy.evacuationRoutes.join(', ')}]`,
        inputs: [
            ...observations.map((o) => ({
                kind: 'road_observation' as const,
                id: o.id,
                note: `${o.roadName ?? o.roadId}: ${o.previousState} -> ${o.state}`,
            })),
            ...(old ? [{ kind: 'planner_job' as const, id: old.jobId, note: 'plan before' }] : []),
            ...(next
                ? [{ kind: 'planner_job' as const, id: next.job.jobId, note: 'plan after' }]
                : []),
        ],
        confidence: report.state === 'uncertain' ? 0.5 : 0.85,
        actions: [
            `POST /v1/watch-zones/${zone.id}/road-observations`,
            ...(next ? [`replanned -> ${next.job.jobId}`] : []),
            ...notifiedResponders.map((r) => `responder message -> ${r}`),
            ...alertDrafts.map((n) => `approval ${n} drafted`),
        ],
    });
    const out: Replan = {
        decisionId: decision.id,
        zoneId: zone.id,
        incidentId: incident?.id ?? null,
        roadIds,
        roadName,
        state: report.state,
        reportedBy: label,
        usedBy,
        oldJobId: old?.jobId ?? null,
        newJobId: next?.job.jobId ?? null,
        diff,
        notifiedResponders,
        alertDrafts,
        at: ctx.now().toISOString(),
    };
    await ctx.memory.setState(`lastReplan:${zone.id}`, out);
    return out;
}
