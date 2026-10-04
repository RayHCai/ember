import type { Approval, Civilian, Incident, PlannerResult, WatchZone } from '@ember/contracts';
import { z } from 'zod';
import { EMBER, type Ctx } from '../context.js';
import { unsupportedNumbers } from '../llm/guard.js';
import {
    impactView,
    routeView,
    type Geography,
    type ImpactView,
    type RouteView,
} from '../views.js';

const MAX_TEXT = 600;

export function mapLink(ctx: Ctx, zoneId: string, areaId: string, jobId: string): string | null {
    const base = ctx.config.civilianMapUrl;
    if (!base) return null;
    const q = new URLSearchParams({ zone: zoneId, area: areaId, plan: jobId });
    return `${base.replace(/\/$/, '')}/?${q.toString()}`;
}

export type AlertFacts = {
    area: string;
    impact: ImpactView;
    route: RouteView | null;
    mapUrl: string | null;
    update: boolean;
    changes: string[];
    householdNotes: string | null;
};

/** The deterministic text: every fact in it is the planner's. */
export function templateAlert(f: AlertFacts): string {
    const parts: string[] = [];
    const when =
        f.impact.fireArrivalMin === null
            ? 'fire may reach your area'
            : f.impact.fireArrivalMin <= 0
              ? 'fire is in or at your area now'
              : `fire may reach your area in about ${Math.round(f.impact.fireArrivalMin)} min`;
    parts.push(`${f.update ? 'Ember UPDATE' : 'Ember wildfire alert'} for ${f.area}: ${when}.`);
    if (f.update && f.changes.length) parts.push(`What changed: ${f.changes.join('; ')}.`);
    const r = f.route;
    if (!r || r.status === 'no_safe_route') {
        parts.push('No safe road route was found. If you cannot leave safely, call 911.');
    } else {
        const via = r.via.length ? ` via ${r.via.join(' then ')}` : '';
        parts.push(
            `Leave now${via} toward ${r.destination ?? 'the exit'} (about ${Math.round(r.etaMin)} min).`,
        );
        if (r.alternate) {
            const alt = r.alternate.via.length ? r.alternate.via.join(' then ') : 'another road';
            parts.push(`If blocked, use ${alt} to ${r.alternate.destination ?? 'the exit'}.`);
        }
    }
    if (f.householdNotes) parts.push(`We have noted: ${f.householdNotes}.`);
    if (f.mapUrl) parts.push(`Map: ${f.mapUrl}`);
    parts.push(
        'Ember forecast, not an official order: follow emergency officials. Reply with questions.',
    );
    return parts.join(' ');
}

const draftSchema = z.object({ body: z.string().min(20).max(MAX_TEXT) });

/**
 * Lets Gemini write the text from the facts. Kept only if it is short, keeps the map link and
 * the disclaimer, and states no number the facts do not contain; otherwise the template stands.
 */
async function drafted(ctx: Ctx, facts: AlertFacts, template: string): Promise<string> {
    if (!ctx.reasoner) return template;
    try {
        const { body } = await ctx.reasoner.structured({
            system:
                'You write SMS/iMessage wildfire alerts for Ember, a wildfire screening tool. Use only the facts given. ' +
                'Never invent times, distances, roads or places. Never call it an official order or impersonate authorities. ' +
                'Plain words, calm and direct, under 480 characters.',
            prompt: `Facts (JSON): ${JSON.stringify(facts)}\n\nTemplate to improve: ${template}\n\nKeep the map URL and the line saying this is an Ember forecast, not an official order.`,
            schema: draftSchema,
        });
        const bad = unsupportedNumbers(body, facts);
        if (
            bad.length ||
            (facts.mapUrl && !body.includes(facts.mapUrl)) ||
            !/not an official/i.test(body)
        ) {
            ctx.log.warn({ bad, body }, 'alert draft rejected; using template');
            return template;
        }
        return body;
    } catch (err) {
        ctx.log.warn({ err: String(err) }, 'alert drafting unavailable; using template');
        return template;
    }
}

/**
 * One approval holding a personalised text per civilian of the area. Nothing is sent until an
 * operator approves it with its confirmation code.
 */
export async function draftCivilianAlert(
    ctx: Ctx,
    zone: WatchZone,
    incident: Incident,
    result: PlannerResult,
    geo: Geography,
    areaId: string,
    opts: { update: boolean; changes?: string[] },
): Promise<Approval | null> {
    const impact = result.civilianImpacts.find((i) => i.civilianAreaId === areaId);
    if (!impact) return null;
    const existing = await ctx.api.approvals({ zoneId: zone.id });
    const same = existing.find(
        (a) =>
            a.draft.kind === 'civilian_alert' &&
            a.draft.jobId === result.jobId &&
            a.draft.civilianAreaId === areaId,
    );
    if (same) return same;
    // One pending draft per area: a fresh plan replaces it only when the area's severity moved.
    const pendingForArea = existing.find(
        (a) =>
            a.state === 'pending' &&
            a.incidentId === incident.id &&
            a.draft.kind === 'civilian_alert' &&
            a.draft.civilianAreaId === areaId,
    );
    if (
        !opts.update &&
        pendingForArea?.draft.kind === 'civilian_alert' &&
        pendingForArea.draft.severity === impact.severity
    ) {
        return pendingForArea;
    }
    const civilians: Civilian[] = (await ctx.api.civilians(zone.id)).filter(
        (c) => c.civilianAreaId === areaId,
    );
    if (!civilians.length) return null;
    const routeRaw = result.evacuationRoutes.find((r) => r.civilianAreaId === areaId);
    const route = routeRaw ? routeView(routeRaw, geo) : null;
    const mapUrl = mapLink(ctx, zone.id, areaId, result.jobId);
    const recipients = [];
    for (const c of civilians) {
        const memory = await ctx.memory.civilianNotes(c.id);
        const notes = [c.notes, ...memory.slice(-2)].filter(Boolean).join('; ') || null;
        const facts: AlertFacts = {
            area: impact.name,
            impact: impactView(impact),
            route,
            mapUrl,
            update: opts.update,
            changes: opts.changes ?? [],
            householdNotes: notes,
        };
        const template = templateAlert(facts);
        recipients.push({
            civilianId: c.id,
            body: (await drafted(ctx, facts, template)).slice(0, 1600),
        });
    }
    const superseded = existing.filter(
        (a) =>
            a.state === 'pending' &&
            a.draft.kind === 'civilian_alert' &&
            a.draft.civilianAreaId === areaId,
    );
    return ctx.api.createApproval({
        zoneId: zone.id,
        incidentId: incident.id,
        draftedBy: EMBER,
        reason:
            `Incident #${incident.number}, plan ${result.jobId.slice(0, 8)}: ${impact.name} is ${impact.severity}` +
            `${impact.impactMin === null ? '' : `, fire in ${Math.round(impact.impactMin)} min`}` +
            `${route ? `, route ${route.status} via ${route.via.join(', ') || 'cross-country'}` : ''}` +
            `${superseded.length ? `. Replaces pending approval ${superseded.map((a) => a.number).join(', ')}` : ''}`,
        draft: {
            kind: 'civilian_alert',
            jobId: result.jobId,
            civilianAreaId: areaId,
            severity: impact.severity,
            recipients,
            mapUrl,
        },
    });
}
