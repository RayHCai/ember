import { z } from 'zod';
import { card, table } from '../cards.js';
import { AgentError, decide, EMBER, geography, resolveZone, runPlanner } from '../context.js';
import { currentPlan, replanCard } from '../playbooks/insight.js';
import { draftCivilianAlert } from '../playbooks/alerts.js';
import { coordinate, escalate, handleRoadReport, openIncidents } from '../playbooks/response.js';
import { requestVerification, simulateFire, startSurveillance } from '../playbooks/surveillance.js';
import { planView } from '../views.js';
import { resetDemo } from '../playbooks/demo.js';
import { tool, type Tool } from './registry.js';

import { incidentFor, responderByNumber, zoneArg } from './shared.js';

/** Tools that change state: operators only. */
export const ACT_TOOLS: Tool[] = [
    tool({
        name: 'create_watch_zone',
        description:
            'Create a watch zone: a circle around a place name (geocoded by OpenStreetMap) or around coordinates the user gave. Never guess coordinates.',
        args: z.object({
            name: z.string().min(1),
            place: z.string().optional().describe('Place name to geocode, e.g. "Lahaina, Hawaii"'),
            lat: z.number().min(-90).max(90).optional(),
            lng: z.number().min(-180).max(180).optional(),
            radiusM: z.number().positive().max(20_000).optional().describe('Default 2000'),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            let center =
                a.lat !== undefined && a.lng !== undefined ? { lat: a.lat, lng: a.lng } : null;
            let label = center ? `${center.lat}, ${center.lng}` : '';
            if (!center && a.place) {
                const hit = await ctx.geocode(a.place);
                if (!hit) throw new AgentError(`could not find "${a.place}"`);
                center = { lat: hit.lat, lng: hit.lng };
                label = hit.label;
            }
            if (!center)
                throw new AgentError(
                    'I need a place name or coordinates for "here"; share a location or name the place',
                );
            const zone = await ctx.api.createZone({
                name: a.name,
                center,
                radiusM: a.radiusM ?? 2000,
            });
            await decide(ctx, {
                zoneId: zone.id,
                incidentId: null,
                domain: 'prevention',
                kind: 'create_zone',
                summary: `Created watch zone ${zone.name}`,
                reason: `requested by ${turn.actor}; centred on ${label}`,
                inputs: [{ kind: 'chat', id: turn.actor, note: label }],
                confidence: 1,
                actions: [`POST /v1/watch-zones -> ${zone.id}`],
            });
            return {
                summary: `Created watch zone ${zone.name}, ${Math.round(zone.areaHa)} ha around ${label}. It has no roads, areas or edge servers until they are added.`,
                data: zone,
            };
        },
    }),
    tool({
        name: 'start_scan',
        description:
            'Start drone surveillance of sectors (default: the highest-risk sector) and set the scan cadence from risk and weather. The drones plan their own flight paths.',
        args: z.object({
            zone: zoneArg,
            sectorIds: z.array(z.string()).optional().describe('e.g. ["S7"]'),
            reason: z.string().optional(),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const out = await startSurveillance(ctx, zone, {
                ...(a.sectorIds ? { sectorIds: a.sectorIds } : {}),
                reason: a.reason ?? `requested by ${turn.actor}`,
                actor: turn.actor,
            });
            return {
                summary: `${out.scan.state === 'failed' ? 'Scan could not start' : 'Scan started'} over ${out.sectors.map((s) => s.id).join(', ')} of ${zone.name}${out.scan.error ? ` (${out.scan.error})` : ''}; surveillance cadence now every ${out.intervalMin} min.`,
                data: { scan: out.scan, intervalMin: out.intervalMin },
                cards: [out.card],
            };
        },
    }),
    tool({
        name: 'stop_scan',
        description: 'Stop a mapping run (default: every running scan of the zone).',
        args: z.object({ zone: zoneArg, runId: z.string().optional() }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const running = (await ctx.api.scans(zone.id)).filter(
                (s) => s.state === 'mapping' && (!a.runId || s.runId === a.runId),
            );
            for (const s of running)
                await ctx.api.stopScan(s.runId, turn.actor, `requested by ${turn.actor}`);
            return { summary: `Stopped ${running.length} scan(s) in ${zone.name}.` };
        },
    }),
    tool({
        name: 'request_verification_scan',
        description: 'Send drones to re-scan around one detection to confirm or dismiss it.',
        args: z.object({ detectionId: z.string(), zone: zoneArg }),
        acts: true,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const d = await ctx.api.detection(a.detectionId);
            const scan = await requestVerification(
                ctx,
                zone,
                d,
                'operator asked for a second look',
            );
            return {
                summary: `Verification ${scan ? `scan ${scan.state}` : 'requested'} for ${d.id}.`,
                data: scan,
            };
        },
    }),
    tool({
        name: 'simulate_fire',
        description:
            'SIMULATION ONLY: place a simulated fire detection in a sector (e.g. "S7") or at given coordinates; Ember then triages it like a real one.',
        args: z.object({
            zone: zoneArg,
            sector: z.string().optional().describe('Sector id like "S7"'),
            lat: z.number().optional(),
            lng: z.number().optional(),
            confidence: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe('Default 0.6: moderate, so Ember verifies it'),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const out = await simulateFire(ctx, zone, {
                ...(a.sector ? { sectorId: a.sector } : {}),
                ...(a.lat !== undefined && a.lng !== undefined
                    ? { location: { lat: a.lat, lng: a.lng } }
                    : {}),
                ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
                actor: turn.actor,
            });
            return {
                summary: `Simulated fire ${out.detection.id} (confidence ${out.detection.confidence}): ${out.outcome}.`,
                data: out,
            };
        },
    }),
    tool({
        name: 'run_planner',
        description:
            'Ask the planner for a new plan (fire spread, attack zones, civilian impacts, evacuation routes, sector risk) and wait for it.',
        args: z.object({
            zone: zoneArg,
            reason: z.string(),
            incidentNumber: z.number().int().optional(),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const incident = a.incidentNumber
                ? await incidentFor(ctx, zone.id, a.incidentNumber)
                : null;
            const view = await runPlanner(ctx, zone.id, {
                reason: a.reason,
                incidentId: incident?.id ?? null,
                requestedBy: turn.actor,
            });
            const geo = await geography(ctx, zone.id);
            return {
                summary: `Plan ${view.job.jobId.slice(0, 8)} ready.`,
                data: planView(view.result!, geo),
            };
        },
    }),
    tool({
        name: 'coordinate_response',
        description:
            'Run the emergency response for the active fire: escalate if needed, plan, assign responders to attack zones, message them, and draft civilian alerts for operator approval.',
        args: z.object({ zone: zoneArg }),
        acts: true,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            let incident = (await openIncidents(ctx, zone.id))[0];
            if (!incident) {
                const ds = (await ctx.api.detections(zone.id)).filter(
                    (d) => d.verification !== 'dismissed',
                );
                if (!ds.length)
                    throw new AgentError(`no fire detected in ${zone.name}; nothing to coordinate`);
                const best = ds.reduce((x, y) => (y.confidence > x.confidence ? y : x));
                incident = await escalate(
                    ctx,
                    zone,
                    [best],
                    'operator asked to coordinate the response',
                    best.confidence,
                );
            }
            let view = incident.latestJobId ? await ctx.api.plan(incident.latestJobId) : null;
            if (!view?.result)
                view = await runPlanner(ctx, zone.id, {
                    reason: `Incident #${incident.number} response`,
                    incidentId: incident.id,
                });
            const active = await ctx.api.assignments(zone.id, {
                incidentId: incident.id,
                state: 'active',
            });
            const done = active.length > 0 && active.every((x) => x.jobId === view.job.jobId);
            // The loop may already have acted on this plan; report that rather than act twice.
            const out = done
                ? {
                      assignment: { assignments: active, superseded: [], unassigned: [] },
                      messagedResponders: [],
                      approvals: (await ctx.api.approvals({ zoneId: zone.id })).filter(
                          (p) =>
                              p.incidentId === incident.id &&
                              p.draft.kind === 'civilian_alert' &&
                              p.draft.jobId === view.job.jobId,
                      ),
                  }
                : await coordinate(ctx, zone, incident, view, { cause: 'operator request' });
            const responders = await ctx.api.responders(zone.id);
            const crews = out.assignment.assignments.map((x) => {
                const r = responders.find((y) => y.id === x.responderId);
                return [`Responder ${r?.number} (${r?.name})`, x.attackZoneLabel, x.instructions];
            });
            return {
                summary: `Incident #${incident.number}${done ? ' was already coordinated on its current plan' : ''}: ${out.assignment.assignments.length} crews assigned, ${out.messagedResponders.length} messaged now; ${out.approvals.filter((p) => p.state === 'pending').length} civilian alert draft(s) await approval.`,
                data: {
                    incident: incident.number,
                    assignments: out.assignment.assignments.map((x) => ({
                        zone: x.attackZoneLabel,
                        instructions: x.instructions,
                    })),
                    unassigned: out.assignment.unassigned,
                    approvals: out.approvals.map((p) => ({
                        number: p.number,
                        area: p.draft.kind === 'civilian_alert' ? p.draft.civilianAreaId : null,
                    })),
                },
                cards: [
                    card(
                        'responder_plan',
                        `Incident #${incident.number}: crews`,
                        crews.length
                            ? table(['Crew', 'Zone', 'Orders'], crews)
                            : 'No responder was available.',
                        out.assignment,
                    ),
                    ...out.approvals.map((p) =>
                        card(
                            'approval',
                            `Approval ${p.number}: civilian alert`,
                            p.draft.kind === 'civilian_alert'
                                ? `${p.reason}\n\n${p.draft.recipients.length} recipient(s). First text:\n\n> ${p.draft.recipients[0]?.body ?? ''}\n\nOperator: hold to approve in the dashboard, or reply \`approve ${p.number} ${p.confirmationCode}\`.`
                                : p.reason,
                            { approvalId: p.id, number: p.number },
                            [
                                {
                                    label: 'Approve',
                                    reply: `approve ${p.number} ${p.confirmationCode}`,
                                },
                                {
                                    label: 'Reject',
                                    reply: `reject ${p.number} ${p.confirmationCode}`,
                                },
                            ],
                        ),
                    ),
                ],
            };
        },
    }),
    tool({
        name: 'assign_responders',
        description:
            "Assign available responders to the plan's attack zones (the api's assignment rules) and message the ones with new orders.",
        args: z.object({ zone: zoneArg, incidentNumber: z.number().int().optional() }),
        acts: true,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const incident = await incidentFor(ctx, zone.id, a.incidentNumber);
            if (!incident.latestJobId)
                throw new AgentError(`Incident #${incident.number} has no plan yet`);
            const out = await coordinate(
                ctx,
                zone,
                incident,
                await ctx.api.plan(incident.latestJobId),
                { cause: 'assignment request', areas: [] },
            );
            return {
                summary: `${out.assignment.assignments.length} assignment(s), ${out.messagedResponders.length} responder(s) messaged.`,
                data: out.assignment,
            };
        },
    }),
    tool({
        name: 'update_road_state',
        description:
            'Record a road report (blocked, open, uncertain) from a responder, civilian or operator, then replan every plan that uses the road and notify only the affected people. Use for reports like "Responder 2 says Ridge Road is blocked".',
        args: z.object({
            zone: zoneArg,
            roadName: z.string().describe('Road name as reported, e.g. "Ridge Road"'),
            state: z.enum(['blocked', 'open', 'uncertain']),
            reporter: z
                .string()
                .describe('Who reported it, e.g. "Responder 2", "Civilian 4", or "operator"'),
            note: z.string().optional(),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const m = /^(responder|civilian)\s*#?(\d+)$/i.exec(a.reporter.trim());
            let reportedBy = turn.actor;
            let source: 'responder' | 'civilian' | 'operator' = 'operator';
            if (m?.[1]?.toLowerCase() === 'responder') {
                const r = await responderByNumber(ctx, zone.id, Number(m[2]));
                reportedBy = `responder:${r.id}`;
                source = 'responder';
            } else if (m?.[1]?.toLowerCase() === 'civilian') {
                const c = (await ctx.api.civilians(zone.id)).find((x) => x.number === Number(m[2]));
                reportedBy = c ? `civilian:${c.id}` : `civilian ${m[2]}`;
                source = 'civilian';
            }
            const replan = await handleRoadReport(ctx, zone, {
                roadName: a.roadName,
                state: a.state,
                source,
                reportedBy,
                reporterLabel: a.reporter,
                note: a.note ?? `${a.reporter}: ${a.roadName} ${a.state}`,
            });
            turn.decisionIds.push(replan.decisionId);
            const d = replan.diff;
            return {
                summary: d
                    ? `${replan.roadName} is ${a.state}. Replanned (${replan.oldJobId?.slice(0, 8)} → ${replan.newJobId?.slice(0, 8)}): ${
                          d.attackZones
                              .filter((w) => w.change !== 'unchanged')
                              .map((w) => `Zone ${w.label} ${w.change}`)
                              .join(', ') || 'no attack zone changed'
                      }; ${d.civilianAreas.map((x) => `${x.area}: ${x.detail.join(', ')}`).join('; ') || 'no civilian area changed'}. Notified ${replan.notifiedResponders.length} responder(s); ${replan.alertDrafts.length} civilian update(s) await approval.`
                    : `${replan.roadName ?? a.roadName} recorded as ${a.state}; no current plan used it, so nothing was replanned.`,
                data: replan,
                cards: [replanCard(replan)],
            };
        },
    }),
    tool({
        name: 'draft_civilian_alert',
        description:
            'Draft personalised alerts for one civilian area from the current plan. Creates a pending approval; nothing is sent until an operator approves.',
        args: z.object({ zone: zoneArg, civilianAreaId: z.string() }),
        acts: true,
        run: async (ctx, a) => {
            const zone = await resolveZone(ctx, a.zone);
            const incident = await incidentFor(ctx, zone.id);
            const view = await currentPlan(ctx, zone);
            if (!view?.result) throw new AgentError('no plan to draft from');
            const approval = await draftCivilianAlert(
                ctx,
                zone,
                incident,
                view.result,
                await geography(ctx, zone.id),
                a.civilianAreaId,
                { update: false },
            );
            if (!approval)
                return {
                    summary: `No registered civilians in ${a.civilianAreaId}, or it is not affected.`,
                };
            return {
                summary: `Approval ${approval.number} drafted; reply "approve ${approval.number} ${approval.confirmationCode}" as an operator to send.`,
                data: { number: approval.number },
            };
        },
    }),
    tool({
        name: 'send_responder_message',
        description:
            "Message one responder (by number) or every responder of the zone through the responder app's feed.",
        args: z.object({
            zone: zoneArg,
            responderNumber: z.number().int().optional(),
            title: z.string().min(1),
            body: z.string().min(1),
            priority: z.enum(['routine', 'urgent', 'critical']).optional(),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const r = a.responderNumber
                ? await responderByNumber(ctx, zone.id, a.responderNumber)
                : null;
            await ctx.api.sendResponderMessage(zone.id, {
                responderId: r?.id ?? null,
                kind: 'update',
                priority: a.priority ?? 'routine',
                title: a.title,
                body: a.body,
                from: turn.actor,
                location: null,
            });
            return {
                summary: `Sent to ${r ? `Responder ${r.number}` : 'every responder'} in ${zone.name}.`,
            };
        },
    }),
    tool({
        name: 'propose_authority_notification',
        description:
            'Draft a notification to a fire department, utility, emergency management or police. It needs explicit operator approval, and Ember never sends it itself: the operator contacts them.',
        args: z.object({
            zone: zoneArg,
            audience: z.enum(['fire_department', 'utility', 'emergency_management', 'police']),
            organization: z.string(),
            subject: z.string(),
            body: z.string(),
        }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const approval = await ctx.api.createApproval({
                zoneId: zone.id,
                draftedBy: EMBER,
                reason: `proposed during a conversation with ${turn.actor}`,
                draft: {
                    kind: 'authority_notification',
                    audience: a.audience,
                    organization: a.organization,
                    subject: a.subject,
                    body: a.body,
                },
            });
            return {
                summary: `Drafted for operator review as approval ${approval.number}. Ember will not contact ${a.organization} itself.`,
                cards: [
                    card(
                        'approval',
                        `Approval ${approval.number}: notify ${a.organization}`,
                        `**${a.subject}**\n\n${a.body}`,
                        { number: approval.number },
                        [
                            {
                                label: 'Approve',
                                reply: `approve ${approval.number} ${approval.confirmationCode}`,
                            },
                        ],
                    ),
                ],
            };
        },
    }),
    tool({
        name: 'reset_demo',
        description:
            'Reset the demo for a zone: close open incidents, remove simulated fires, reopen reported roads, stop scans. Use when the user asks to reset, start over or clear the demo.',
        args: z.object({ zone: zoneArg }),
        acts: true,
        run: async (ctx, a, turn) => {
            const zone = await resolveZone(ctx, a.zone);
            const actions = await resetDemo(ctx, zone, turn.actor);
            return {
                summary: `The ${zone.name} demo is reset${actions.length ? `: ${actions.join('; ')}` : '; nothing needed clearing'}. Start with "Analyze wildfire risk around ${zone.name}."`,
            };
        },
    }),
];
