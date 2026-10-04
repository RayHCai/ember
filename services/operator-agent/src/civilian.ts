import type { Civilian, CivilianMessage, WatchZone } from '@ember/contracts';
import { handleOf } from './channels.js';
import { decide, describeError, EMBER, geography, type Ctx } from './context.js';
import { unsupportedNumbers } from './llm/guard.js';
import { parseObservation, type Observation } from './observations.js';
import { mapLink } from './playbooks/alerts.js';
import { currentPlan } from './playbooks/insight.js';
import { handleRoadReport } from './playbooks/response.js';
import { impactView, roadNames, routeView, type ImpactView, type RouteView } from './views.js';

const DISCLAIMER = 'Ember forecast, not an official order: follow emergency officials.';

type CivilianFacts = {
    civilian: string;
    area: string | null;
    impact: ImpactView | null;
    route: RouteView | null;
    roadsNotOpen: { name: string; state: string }[];
    mapUrl: string | null;
    notes: string[];
};

function normalize(name: string) {
    return name
        .toLowerCase()
        .replace(/\bhighway\b/g, 'hwy')
        .replace(/\broad\b/g, 'rd')
        .replace(/\bstreet\b/g, 'st')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function mentions(names: string[], asked: string): string | null {
    const q = normalize(asked);
    return names.find((n) => normalize(n).includes(q) || q.includes(normalize(n))) ?? null;
}

/** The deterministic answer to the parsed message, from the civilian's stored context. */
export function answer(o: Observation, f: CivilianFacts): string {
    const where = f.area ?? 'your area';
    const leave =
        f.route && f.route.status !== 'no_safe_route'
            ? `Leave via ${f.route.via.join(' then ') || 'the nearest road out'} toward ${f.route.destination ?? 'the exit'} (about ${Math.round(f.route.etaMin)} min).`
            : null;
    if (o.kind === 'question' && o.question === 'road' && o.roadName) {
        const blocked = f.roadsNotOpen.find((r) => mentions([r.name], o.roadName!));
        if (blocked)
            return `${blocked.name} is reported ${blocked.state}. ${leave ?? ''} ${DISCLAIMER}`.trim();
        if (f.route && mentions(f.route.via, o.roadName))
            return `Yes, ${o.roadName} is on your evacuation route. ${leave} ${DISCLAIMER}`;
        if (f.route?.alternate && mentions(f.route.alternate.via, o.roadName)) {
            return `${o.roadName} is on your alternate route, to ${f.route.alternate.destination}. Your first choice: ${leave} ${DISCLAIMER}`;
        }
        return `${o.roadName} is not on your planned route. ${leave ?? 'No route is planned for your area right now.'} ${DISCLAIMER}`;
    }
    if (
        o.kind === 'question' &&
        (o.question === 'evacuate' || o.question === 'route' || o.question === 'risk')
    ) {
        const i = f.impact;
        if (!i)
            return `Ember has no fire forecast for ${where} right now. We will text you if that changes.`;
        if (i.severity === 'immediate' || i.severity === 'warning') {
            const when =
                i.fireArrivalMin === null ? '' : ` in about ${Math.round(i.fireArrivalMin)} min`;
            return `Yes. Ember's forecast has fire reaching ${where}${when}. ${leave ?? 'No safe road route was found; call 911 if you cannot leave safely.'}${f.mapUrl ? ` Map: ${f.mapUrl}` : ''} ${DISCLAIMER}`;
        }
        if (i.severity === 'watch') {
            return `Not yet. Fire may reach ${where} in about ${Math.round(i.fireArrivalMin ?? 0)} min if nothing changes. Be ready to go. ${leave ?? ''} ${DISCLAIMER}`.trim();
        }
        return `Ember's current forecast does not reach ${where}. We will text you if that changes.`;
    }
    if (o.kind === 'road') {
        return o.roadName
            ? `Thank you. We've logged your report that ${o.roadName} is ${o.roadState} and are checking routes now.`
            : 'Thank you. Which road is blocked? Send its name and we will reroute.';
    }
    if (o.kind === 'fire_sighting')
        return 'Thank you. We logged your fire report and are sending drones to look. If you are in danger, call 911.';
    if (o.kind === 'check_in') return "Thank you, we've noted that you are safe.";
    if (o.kind === 'household') return "Thank you, we've noted that for your household.";
    return `This is Ember, a wildfire alert service. Ask "Do I need to evacuate?" or "Can I take <road>?". If you are in danger, call 911.`;
}

async function facts(ctx: Ctx, civilian: Civilian, zone: WatchZone | null): Promise<CivilianFacts> {
    const notes = await ctx.memory.civilianNotes(civilian.id);
    const base: CivilianFacts = {
        civilian: `Civilian ${civilian.number}`,
        area: null,
        impact: null,
        route: null,
        roadsNotOpen: [],
        mapUrl: null,
        notes,
    };
    if (!zone || !civilian.civilianAreaId) return base;
    const geo = await geography(ctx, zone.id);
    const view = await currentPlan(ctx, zone);
    const result = view?.result;
    const area = geo.civilianAreas.find((a) => a.id === civilian.civilianAreaId);
    const impact = result?.civilianImpacts.find(
        (i) => i.civilianAreaId === civilian.civilianAreaId,
    );
    const route = result?.evacuationRoutes.find(
        (r) => r.civilianAreaId === civilian.civilianAreaId,
    );
    return {
        ...base,
        area: area?.name ?? null,
        impact: impact ? impactView(impact) : null,
        route: route ? routeView(route, geo) : null,
        roadsNotOpen: geo.roads
            .filter((r) => r.state !== 'open')
            .map((r) => ({ name: roadNames(geo.roads, [r.id])[0]!, state: r.state })),
        mapUrl: result ? mapLink(ctx, zone.id, civilian.civilianAreaId, result.jobId) : null,
    };
}

async function polish(ctx: Ctx, text: string, message: string, f: CivilianFacts): Promise<string> {
    if (!ctx.reasoner) return text;
    try {
        const { text: out } = await ctx.reasoner.converse({
            system:
                'You are Ember texting a resident about wildfire. Rewrite the draft reply warmly and briefly (under 400 characters) for their message. ' +
                'Use only the facts given; never add a number, road or place. Keep the line that this is an Ember forecast, not an official order, when present.',
            history: [],
            text: `Their message: "${message}"\nDraft reply: ${text}\nFacts: ${JSON.stringify(f)}`,
            tools: [],
            run: async () => ({}),
            maxSteps: 1,
        });
        if (
            !out ||
            unsupportedNumbers(out, { f, text }).length ||
            (text.includes('not an official') && !/not an official/i.test(out))
        )
            return text;
        return out;
    } catch {
        return text;
    }
}

/**
 * Answers one inbound civilian text from their stored context, turns reports into observations,
 * and replies inside the conversation they started.
 */
export async function handleInbound(ctx: Ctx, message: CivilianMessage): Promise<void> {
    const civilian = await ctx.api.civilian(message.civilianId);
    const zone = civilian.zoneId ? await ctx.api.zone(civilian.zoneId) : null;
    const o: Observation = message.attachments.some((a) => a.mimeType.startsWith('image/'))
        ? {
              kind: 'fire_sighting',
              roadName: null,
              roadState: null,
              responderStatus: null,
              householdNote: null,
              question: null,
          }
        : await parseObservation(ctx, message.body, `Civilian ${civilian.number}`);
    const f = await facts(ctx, civilian, zone);
    if (o.householdNote)
        await ctx.memory.addCivilianNote(civilian.id, o.householdNote, message.createdAt);

    if (zone && o.kind === 'road' && o.roadName && o.roadState) {
        try {
            await handleRoadReport(ctx, zone, {
                roadName: o.roadName,
                state: o.roadState === 'open' ? 'open' : 'uncertain',
                source: 'civilian',
                reportedBy: `civilian:${civilian.id}`,
                reporterLabel: `Civilian ${civilian.number}`,
                note: message.body,
            });
        } catch (err) {
            ctx.log.warn({ err: describeError(err) }, 'civilian road report not applied');
        }
    }
    if (zone && o.kind === 'fire_sighting') {
        await ctx.api.createReport(zone.id, {
            source: 'civilian',
            reporterId: `civilian:${civilian.id}`,
            text: message.body || '(photo)',
            location: civilian.location,
            photoUrl: message.attachments[0]?.url ?? null,
        });
        if (civilian.location) {
            await ctx.api
                .startScan(zone.id, {
                    purpose: 'verification',
                    reason: `civilian ${civilian.number} reported fire`,
                    requestedBy: EMBER,
                    focus: { center: civilian.location, radiusM: 600 },
                })
                .catch((err: unknown) =>
                    ctx.log.warn(
                        { err: describeError(err) },
                        'verification scan for a civilian report failed',
                    ),
                );
        }
        await decide(ctx, {
            zoneId: zone.id,
            incidentId: null,
            domain: 'civilian',
            kind: 'civilian_report',
            summary: `Civilian ${civilian.number} reported fire${message.attachments.length ? ' with a photo' : ''}`,
            reason: 'reports from residents are verified by drones before they count as detections',
            inputs: [{ kind: 'message', id: message.id, note: message.body.slice(0, 120) }],
            confidence: 0.4,
            actions: civilian.location
                ? ['verification scan requested at their location']
                : ['logged; no location known'],
        });
    }

    const reply = await polish(ctx, answer(o, f), message.body, f);
    const queued = await ctx.api.queueCivilianMessage({
        civilianId: civilian.id,
        channel: message.channel,
        body: reply,
        inReplyTo: message.id,
    });
    try {
        await ctx.transport.send(handleOf(civilian), reply);
        await ctx.api.reportDelivery(queued.id, 'sent');
    } catch (err) {
        await ctx.api.reportDelivery(queued.id, 'failed', describeError(err));
    }
}
