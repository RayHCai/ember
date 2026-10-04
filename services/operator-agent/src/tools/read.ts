import { z } from 'zod';
import { card, minutes, SCREENING_NOTE, table } from '../cards.js';
import { AgentError, geography, resolveZone } from '../context.js';
import { diffPlans } from '../diff.js';
import {
    civiliansToEvacuate,
    explainDecision,
    explainRoute,
    incidentState,
    whatChanged,
    whatHappened,
} from '../playbooks/insight.js';
import { openIncidents } from '../playbooks/response.js';
import { rankingCard, riskPlan } from '../playbooks/surveillance.js';
import { attackZoneView, fireView, impactView, planView, routeView } from '../views.js';
import { tool, type Tool } from './registry.js';

import { jobArg, plan, zoneArg } from './shared.js';

/** Tools that only read: any ASI:One user may call them. */
export const READ_TOOLS: Tool[] = [
    tool({
        name: 'get_watch_zones',
        description: 'List Ember watch zones with their surveillance cadence.',
        args: z.object({}),
        acts: false,
        run: async (ctx) => {
            const zones = await ctx.api.zones();
            return {
                summary: zones.length
                    ? zones
                          .map(
                              (w) =>
                                  `${w.name} (${Math.round(w.areaHa)} ha${w.surveillance?.intervalMin ? `, scanned every ${w.surveillance.intervalMin} min` : ''})`,
                          )
                          .join('; ')
                    : 'No watch zones yet.',
                data: zones.map((w) => ({
                    id: w.id,
                    name: w.name,
                    center: w.center,
                    areaHa: w.areaHa,
                    surveillance: w.surveillance,
                })),
            };
        },
    }),
    tool({
        name: 'rank_regions',
        description:
            "Rank a zone's sectors by the planner's wildfire risk score, with the main factors. Use for risk analysis and 'where is the greatest risk'.",
        args: z.object({
            zone: zoneArg,
            refresh: z
                .boolean()
                .optional()
                .describe('Run a fresh risk plan even if a recent one exists'),
        }),
        acts: false,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const view = await riskPlan(ctx, zone, {
                reason: `risk analysis requested by ${turn.actor}`,
                actor: turn.actor,
                ...(a.refresh && turn.operator ? { maxAgeMin: 0 } : {}),
            });
            const sectors = view.result!.sectorRisks;
            const top = sectors[0];
            const weather = (await ctx.api.weather(zone.id)).weather;
            return {
                summary: top
                    ? `Highest wildfire risk in ${zone.name}: sector ${top.id} (score ${top.score.toFixed(2)}, ${top.band}): ${top.drivers.join('; ')}. ` +
                      `Next: ${sectors
                          .slice(1, 3)
                          .map((s) => `${s.id} ${s.score.toFixed(2)}`)
                          .join(', ')}.`
                    : `${zone.name} has no sectors to rank.`,
                data: {
                    jobId: view.job.jobId,
                    weather,
                    sectors: sectors.slice(0, 8),
                    assumptions: view.result!.assumptions,
                },
                cards: [rankingCard(zone, sectors, view.job.jobId)],
            };
        },
    }),
    tool({
        name: 'get_risk_zones',
        description: 'Mapped areas the api holds as at risk or on fire.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const zones = await ctx.api.riskZones(zone.id);
            return {
                summary: `${zones.length} risk zone(s): ${zones.filter((w) => w.risk === 'on_fire').length} on fire.`,
                data: zones.map(({ polygon: _, ...w }) => w),
            };
        },
    }),
    tool({
        name: 'get_weather',
        description:
            'Current weather for a zone (wind, gusts, humidity, temperature, red flag warning) and its source.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const { weather: w } = await ctx.api.weather(zone.id);
            return {
                summary: w
                    ? `${zone.name}: wind ${w.windSpeedMps} m/s from ${w.windFromDeg}°${w.windGustMps ? `, gusts ${w.windGustMps}` : ''}, humidity ${w.relativeHumidityPct ?? '—'}%, ${w.temperatureC ?? '—'} °C${w.redFlagWarning ? ', RED FLAG WARNING' : ''} (${w.source}).`
                    : `No weather for ${zone.name}.`,
                data: w,
            };
        },
    }),
    tool({
        name: 'get_detections',
        description:
            'Recent drone, simulated and civilian-reported fire detections with confidence and verification state.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const ds = (await ctx.api.detections(zone.id)).slice(0, 20);
            return {
                summary: ds.length
                    ? ds
                          .map(
                              (d) =>
                                  `${d.id}: ${d.risk} ${d.confidence.toFixed(2)} (${d.source}, ${d.verification})`,
                          )
                          .join('; ')
                    : 'No detections.',
                data: ds.map(({ ground: _, bboxPx: __, ...d }) => d),
            };
        },
    }),
    tool({
        name: 'get_planner_result',
        description:
            'Summary of a plan: fire, attack zones, civilian impacts, routes, top sectors, assumptions.',
        args: z.object({ zone: zoneArg, jobId: jobArg }),
        acts: false,
        run: async (ctx, a) => {
            const { result, geo } = await plan(ctx, a.zone, a.jobId);
            return {
                summary: `Plan ${result.jobId.slice(0, 8)} from ${result.generatedAt}.`,
                data: planView(result, geo),
            };
        },
    }),
    tool({
        name: 'get_fire_spread',
        description:
            "The planner's fire spread forecast: heading, max spread rate, burnt area at each isochrone.",
        args: z.object({ zone: zoneArg, jobId: jobArg }),
        acts: false,
        run: async (ctx, a) => {
            const { result } = await plan(ctx, a.zone, a.jobId);
            const f = fireView(result);
            return {
                summary: `Fire heads ${f.heading ?? '—'} at up to ${f.maxSpreadMpm} m/min; ${f.isochrones.map((i) => `${i.atMin} min: ${i.areaHa} ha`).join(', ')}.`,
                data: { ...f, assumptions: result.assumptions },
            };
        },
    }),
    tool({
        name: 'get_civilian_impacts',
        description:
            'Civilian areas by how soon fire reaches them (immediate ≤ 60 min, warning ≤ 120, watch, clear).',
        args: z.object({ zone: zoneArg, jobId: jobArg }),
        acts: false,
        run: async (ctx, a) => {
            const { result } = await plan(ctx, a.zone, a.jobId);
            const v = result.civilianImpacts.map(impactView);
            return {
                summary: v
                    .map(
                        (i) =>
                            `${i.area}: ${i.severity}${i.fireArrivalMin === null ? '' : `, ${i.fireArrivalMin} min`}`,
                    )
                    .join('; '),
                data: v,
            };
        },
    }),
    tool({
        name: 'get_evacuation_routes',
        description:
            'Evacuation routes per civilian area (roads, destination, ETA, lead over the fire, alternate).',
        args: z.object({ zone: zoneArg, jobId: jobArg, civilianAreaId: z.string().optional() }),
        acts: false,
        run: async (ctx, a) => {
            const { result, geo } = await plan(ctx, a.zone, a.jobId);
            const v = result.evacuationRoutes
                .filter((r) => !a.civilianAreaId || r.civilianAreaId === a.civilianAreaId)
                .map((r) => routeView(r, geo));
            return {
                summary:
                    v
                        .map(
                            (r) =>
                                `${r.area}: ${r.status} via ${r.via.join(' → ') || 'cross-country'} to ${r.destination}`,
                        )
                        .join('; ') || 'No routes.',
                data: v,
            };
        },
    }),
    tool({
        name: 'get_attack_zones',
        description:
            'Recommended attack zones: drop site road, approach, tactic, fire arrival, who they protect.',
        args: z.object({ zone: zoneArg, jobId: jobArg }),
        acts: false,
        run: async (ctx, a) => {
            const { result, geo } = await plan(ctx, a.zone, a.jobId);
            const v = result.attackZones.map((w) => attackZoneView(w, geo));
            return {
                summary: v
                    .map(
                        (w) =>
                            `Zone ${w.label}: ${w.tactic}, fire in ${w.fireArrivalMin} min, drop site on ${w.dropSiteRoad ?? 'no road'}`,
                    )
                    .join('; '),
                data: v,
                cards: [
                    card(
                        'responder_plan',
                        'Attack zones',
                        table(
                            [
                                'Zone',
                                'Tactic',
                                'Fire arrival',
                                'Drop site',
                                'Approach from',
                                'Protects',
                            ],
                            v.map((w) => [
                                w.label,
                                w.tactic,
                                minutes(w.fireArrivalMin),
                                w.dropSiteRoad,
                                w.approachFrom,
                                w.protects.join(', '),
                            ]),
                        ),
                        v,
                    ),
                ],
            };
        },
    }),
    tool({
        name: 'diff_plans',
        description:
            "Compare two plans (default: the incident's previous and latest) by attack zone and civilian area.",
        args: z.object({
            zone: zoneArg,
            oldJobId: z.string().optional(),
            newJobId: z.string().optional(),
        }),
        acts: false,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const incident = (await openIncidents(ctx, zone.id))[0];
            const oldId = a.oldJobId ?? incident?.previousJobId;
            const newId = a.newJobId ?? incident?.latestJobId;
            if (!oldId || !newId) throw new AgentError('need two plans to compare');
            const [o, n] = await Promise.all([ctx.api.plan(oldId), ctx.api.plan(newId)]);
            const diff = diffPlans(o.result!, n.result!, await geography(ctx, zone.id));
            return {
                summary: `${diff.attackZones.filter((w) => w.change !== 'unchanged').length} attack zone change(s), ${diff.civilianAreas.length} civilian area change(s).`,
                data: diff,
            };
        },
    }),
    tool({
        name: 'what_changed',
        description:
            'What changed in the last replan: the road report, which plans used it, the diff, and who was notified.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const out = await whatChanged(ctx, await resolveZone(ctx, a.zone));
            return { summary: out.card.markdown, data: out.replan, cards: [out.card] };
        },
    }),
    tool({
        name: 'list_civilians_to_evacuate',
        description:
            'Registered civilians in areas at warning or immediate severity, with their route and alert status.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const out = await civiliansToEvacuate(ctx, await resolveZone(ctx, a.zone));
            return {
                summary: `${out.rows.length} civilian(s) need to evacuate. ${SCREENING_NOTE}`,
                data: out.rows,
                cards: [out.card],
            };
        },
    }),
    tool({
        name: 'explain_route',
        description:
            "Explain why a civilian (by number, e.g. Civilian 4) was routed the way they were, from the planner's route, impact, fire forecast and assumptions.",
        args: z.object({ zone: zoneArg, civilianNumber: z.number().int().positive() }),
        acts: false,
        run: async (ctx, a) => {
            const out = await explainRoute(ctx, await resolveZone(ctx, a.zone), a.civilianNumber);
            return { summary: out.text, data: out.card.data, cards: [out.card] };
        },
    }),
    tool({
        name: 'get_incident_state',
        description:
            'Open incidents: plan summary, crews and orders, recent timeline, pending approvals.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const out = await incidentState(ctx, await resolveZone(ctx, a.zone));
            return { summary: out.card.markdown, data: out.incidents, cards: [out.card] };
        },
    }),
    tool({
        name: 'list_pending_approvals',
        description: 'Approvals waiting for an operator decision.',
        args: z.object({}),
        acts: false,
        run: async (ctx, _a, turn) => {
            const pending = await ctx.api.approvals({ state: 'pending' });
            return {
                summary: pending.length
                    ? pending.map((p) => `approval ${p.number}: ${p.reason}`).join('\n')
                    : 'Nothing awaits approval.',
                cards: pending.map((p) =>
                    card(
                        'approval',
                        `Approval ${p.number}`,
                        p.reason,
                        { number: p.number },
                        turn.operator
                            ? [
                                  {
                                      label: 'Approve',
                                      reply: `approve ${p.number} ${p.confirmationCode}`,
                                  },
                              ]
                            : [],
                    ),
                ),
            };
        },
    }),
    tool({
        name: 'explain_decision',
        description: 'Explain one logged decision (by number or id) from its reason and inputs.',
        args: z.object({ decision: z.string() }),
        acts: false,
        run: async (ctx, a) => {
            const out = await explainDecision(ctx, a.decision);
            return { summary: out.text, data: out.decision, cards: [out.card] };
        },
    }),
    tool({
        name: 'what_happened',
        description:
            'Tell what Ember did and why, in order, from the decision log and the current plan.',
        args: z.object({ zone: zoneArg }),
        acts: false,
        run: async (ctx, a) => {
            const out = await whatHappened(ctx, await resolveZone(ctx, a.zone));
            return { summary: out.text, cards: [out.card] };
        },
    }),
];
