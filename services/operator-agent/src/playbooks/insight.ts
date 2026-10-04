import type { AgentCard, Decision, PlannerJobView, WatchZone } from '@ember/contracts';
import { card, minutes, SCREENING_NOTE, table } from '../cards.js';
import { AgentError, geography, type Ctx } from '../context.js';
import { unsupportedNumbers } from '../llm/guard.js';
import { attackZoneView, fireView, impactView, planView, routeView } from '../views.js';
import { openIncidents, type Replan } from './response.js';

/** The plan people are acting on: the open incident's, else the zone's newest. */
export async function currentPlan(ctx: Ctx, zone: WatchZone): Promise<PlannerJobView | null> {
    const incident = (await openIncidents(ctx, zone.id)).find((i) => i.latestJobId);
    if (incident?.latestJobId) return ctx.api.plan(incident.latestJobId);
    return ctx.api.latestPlan(zone.id);
}

async function requirePlan(ctx: Ctx, zone: WatchZone): Promise<PlannerJobView> {
    const view = await currentPlan(ctx, zone);
    if (!view?.result)
        throw new AgentError(
            `${zone.name} has no plan yet; ask me to analyze risk or coordinate a response`,
        );
    return view;
}

/** Asks the model to explain `facts`; keeps its text only if every number in it is from them. */
export async function explain(
    ctx: Ctx,
    question: string,
    facts: unknown,
    fallback: string,
): Promise<string> {
    if (!ctx.reasoner) return fallback;
    try {
        const { text } = await ctx.reasoner.converse({
            system:
                'You are Ember, a wildfire operations agent. Explain using only the JSON facts given: ' +
                'they are real planner output and Ember decision records. Quote numbers exactly as given; ' +
                'never estimate new ones. Mention the planner assumptions when they matter. ' +
                'The planner is a screening model, not an official order. Be concise: at most 6 sentences.',
            history: [],
            text: `${question}\n\nFacts (JSON):\n${JSON.stringify(facts)}`,
            tools: [],
            run: async () => ({}),
            maxSteps: 1,
        });
        const bad = unsupportedNumbers(text, facts);
        if (!text || bad.length) {
            ctx.log.warn({ bad }, 'explanation rejected: numbers not in the facts');
            return fallback;
        }
        return text;
    } catch (err) {
        ctx.log.warn({ err: String(err) }, 'explanation unavailable; using the template');
        return fallback;
    }
}

export async function civiliansToEvacuate(ctx: Ctx, zone: WatchZone) {
    const view = await requirePlan(ctx, zone);
    const result = view.result!;
    const geo = await geography(ctx, zone.id);
    const civilians = await ctx.api.civilians(zone.id);
    const approvals = await ctx.api.approvals({ zoneId: zone.id });
    const rows = [];
    for (const impact of result.civilianImpacts.filter(
        (i) => i.severity === 'immediate' || i.severity === 'warning',
    )) {
        const route = result.evacuationRoutes.find(
            (r) => r.civilianAreaId === impact.civilianAreaId,
        );
        const rv = route ? routeView(route, geo) : null;
        const alert = approvals.find(
            (a) =>
                a.draft.kind === 'civilian_alert' &&
                a.draft.civilianAreaId === impact.civilianAreaId,
        );
        for (const c of civilians.filter((x) => x.civilianAreaId === impact.civilianAreaId)) {
            rows.push({
                civilian: `Civilian ${c.number}`,
                civilianId: c.id,
                area: impact.name,
                severity: impact.severity,
                fireArrivalMin: impact.impactMin,
                route: rv
                    ? `${rv.via.join(' → ') || 'cross-country'} to ${rv.destination ?? '—'} (${rv.status})`
                    : 'no route',
                alert: alert ? `approval ${alert.number}: ${alert.state}` : 'not drafted',
            });
        }
    }
    const markdown = rows.length
        ? table(
              ['Civilian', 'Area', 'Severity', 'Fire arrival', 'Route', 'Alert'],
              rows.map((r) => [
                  r.civilian,
                  r.area,
                  r.severity,
                  minutes(r.fireArrivalMin),
                  r.route,
                  r.alert,
              ]),
          )
        : 'No registered civilian is in an area at warning or immediate severity.';
    return {
        jobId: result.jobId,
        rows,
        card: card(
            'civilian_plan',
            `Civilians to evacuate, ${zone.name}`,
            `${markdown}\n\n_${SCREENING_NOTE}_`,
            { jobId: result.jobId, rows },
        ),
    };
}

export async function explainRoute(ctx: Ctx, zone: WatchZone, civilianNumber: number) {
    const civilians = await ctx.api.civilians(zone.id);
    const civilian = civilians.find((c) => c.number === civilianNumber);
    if (!civilian)
        throw new AgentError(`Civilian ${civilianNumber} is not registered in ${zone.name}`);
    if (!civilian.civilianAreaId)
        throw new AgentError(`Civilian ${civilianNumber} has no known area yet`);
    const view = await requirePlan(ctx, zone);
    const result = view.result!;
    const geo = await geography(ctx, zone.id);
    const impact = result.civilianImpacts.find((i) => i.civilianAreaId === civilian.civilianAreaId);
    const route = result.evacuationRoutes.find((r) => r.civilianAreaId === civilian.civilianAreaId);
    const closed = geo.roads
        .filter((r) => r.state !== 'open')
        .map((r) => `${r.name ?? r.id} (${r.state})`);
    const facts = {
        civilian: `Civilian ${civilian.number}`,
        area: impact?.name ?? civilian.civilianAreaId,
        impact: impact ? impactView(impact) : null,
        route: route ? routeView(route, geo) : null,
        fire: fireView(result),
        roadsNotOpen: [...new Set(closed)],
        assumptions: result.assumptions,
        planJobId: result.jobId,
    };
    const r = facts.route;
    const fallback = r
        ? `${facts.civilian} lives in ${facts.area}. The planner routes ${facts.area} ${r.heads ?? ''} via ${r.via.join(' then ') || 'cross-country'} to ${r.destination ?? 'an exit'} ` +
          `(${r.distanceKm} km, about ${r.etaMin} min) because that path stays at least ${r.clearanceMin ?? 'the full horizon'} min ahead of the fire at every point` +
          `${facts.impact?.fireArrivalMin != null ? `, while fire reaches ${facts.area} in about ${facts.impact.fireArrivalMin} min` : ''}. ` +
          `The fire is forecast to head ${facts.fire.heading ?? 'nowhere in particular'}` +
          `${facts.roadsNotOpen.length ? `, and ${facts.roadsNotOpen.join(', ')} are excluded or slowed` : ''}. ` +
          `${r.alternate ? `The alternate avoids every road of the primary: ${r.alternate.via.join(' then ')} to ${r.alternate.destination}. ` : ''}` +
          `Assumptions: ${result.assumptions.join('; ') || 'none'}.`
        : `${facts.civilian}'s area has no evacuation route in plan ${result.jobId.slice(0, 8)}: its severity is ${facts.impact?.severity ?? 'unknown'}.`;
    const text = await explain(ctx, `Why was ${facts.civilian} routed this way?`, facts, fallback);
    return {
        text,
        card: card(
            'civilian_plan',
            `${facts.civilian}: route and reasons`,
            r
                ? table(
                      ['', 'Primary', 'Alternate'],
                      [
                          [
                              'Via',
                              r.via.join(' → ') || 'cross-country',
                              r.alternate?.via.join(' → ') ?? '—',
                          ],
                          ['To', r.destination, r.alternate?.destination ?? '—'],
                          ['Heads', r.heads, r.alternate?.heads ?? '—'],
                          ['ETA', minutes(r.etaMin), minutes(r.alternate?.etaMin)],
                          [
                              'Lead over fire',
                              minutes(r.clearanceMin),
                              minutes(r.alternate?.clearanceMin),
                          ],
                          ['Status', r.status, r.alternate?.status ?? '—'],
                      ],
                  ) + `\n\nAssumptions: ${result.assumptions.join('; ') || 'none'}`
                : 'No route.',
            facts,
        ),
    };
}

export function replanCard(replan: Replan): AgentCard {
    const d = replan.diff;
    const lines = [
        `**${replan.roadName ?? replan.roadIds.join(', ')}** reported **${replan.state}** by ${replan.reportedBy}.`,
        `Plan ${replan.oldJobId?.slice(0, 8) ?? '—'} used it for attack zones [${replan.usedBy.attackZones.join(', ') || 'none'}] and evacuation routes of [${replan.usedBy.evacuationRoutes.join(', ') || 'none'}].`,
    ];
    if (d) {
        const zones = d.attackZones.filter((z) => z.change !== 'unchanged');
        lines.push(
            '',
            zones.length
                ? table(
                      ['Attack zone', 'Change', 'Detail'],
                      zones.map((z) => [z.label, z.change, z.detail]),
                  )
                : 'No attack zone changed.',
            '',
            d.civilianAreas.length
                ? table(
                      ['Civilian area', 'Changes'],
                      d.civilianAreas.map((a) => [a.area, a.detail.join('; ')]),
                  )
                : 'No civilian area changed.',
            '',
            `Notified ${replan.notifiedResponders.length} responder(s); ${replan.alertDrafts.length ? `civilian update draft(s) ${replan.alertDrafts.join(', ')} await operator approval` : 'no civilian update needed'}.`,
        );
    } else {
        lines.push('No replan was needed.');
    }
    return card('plan_diff', 'What changed', lines.join('\n'), replan);
}

export async function whatChanged(ctx: Ctx, zone: WatchZone) {
    const replan = await ctx.memory.getState<Replan>(`lastReplan:${zone.id}`);
    if (!replan) throw new AgentError(`nothing has been replanned in ${zone.name} yet`);
    return { replan, card: replanCard(replan) };
}

export async function incidentState(ctx: Ctx, zone: WatchZone) {
    const incidents = await ctx.api.incidents(zone.id);
    const open = incidents.filter((i) => i.state !== 'closed');
    const [assignments, responders, approvals] = await Promise.all([
        ctx.api.assignments(zone.id, { state: 'active' }),
        ctx.api.responders(zone.id),
        ctx.api.approvals({ zoneId: zone.id }),
    ]);
    const geo = await geography(ctx, zone.id);
    const blocks: string[] = [];
    const data = [];
    for (const incident of open.slice(0, 3)) {
        const view = await ctx.api.incident(incident.id);
        const plan = incident.latestJobId
            ? (await ctx.api.plan(incident.latestJobId)).result
            : null;
        const crews = assignments
            .filter((a) => a.incidentId === incident.id)
            .map((a) => {
                const r = responders.find((x) => x.id === a.responderId);
                return [
                    `Responder ${r?.number ?? '?'} (${r?.name ?? a.responderId})`,
                    `Zone ${a.attackZoneLabel}`,
                    a.instructions,
                ];
            });
        blocks.push(
            `### Incident #${incident.number}: ${incident.title} (${incident.state})`,
            plan
                ? `Fire heading ${fireView(plan).heading ?? '—'}, max spread ${fireView(plan).maxSpreadMpm} m/min; ${plan.attackZones.length} attack zones; ` +
                      `${plan.civilianImpacts.filter((i) => i.severity === 'immediate').length} area(s) immediate.`
                : 'No plan yet.',
            crews.length ? table(['Crew', 'Zone', 'Orders'], crews) : 'No crews assigned.',
            view.events
                .slice(-5)
                .map((e) => `- ${e.at.slice(11, 16)} ${e.kind}: ${e.summary}`)
                .join('\n'),
        );
        data.push({
            incident,
            plan: plan ? planView(plan, geo) : null,
            attackZones: plan?.attackZones.map((z) => attackZoneView(z, geo)) ?? [],
            events: view.events.slice(-10),
        });
    }
    const pending = approvals.filter((a) => a.state === 'pending');
    if (pending.length) {
        blocks.push(
            `**Awaiting operator approval:** ${pending.map((a) => `approval ${a.number}`).join(', ')}`,
        );
    }
    return {
        incidents: data,
        pending,
        card: card(
            'incident',
            open.length ? `Incidents in ${zone.name}` : `No open incidents in ${zone.name}`,
            blocks.join('\n\n') || 'All quiet.',
            { incidents: data },
            pending.map((a) => ({
                label: `Approve ${a.number}`,
                reply: `approve ${a.number} ${a.confirmationCode}`,
            })),
        ),
    };
}

export async function explainDecision(ctx: Ctx, ref: string) {
    const decision = await ctx.memory.decision(ref.replace(/^#/, ''));
    if (!decision) throw new AgentError(`no decision ${ref}`);
    const fallback = `Decision ${decision.number} (${decision.kind}, ${decision.at}): ${decision.summary}. Why: ${decision.reason}. Inputs: ${decision.inputs.map((i) => `${i.kind} ${i.id} (${i.note})`).join('; ')}. Confidence ${decision.confidence}.`;
    return {
        decision,
        text: await explain(ctx, 'Explain this decision.', decision, fallback),
        card: decisionCard([decision], `Decision ${decision.number}`),
    };
}

export function decisionCard(decisions: Decision[], title: string): AgentCard {
    return card(
        'decision',
        title,
        table(
            ['#', 'Time', 'Kind', 'What', 'Why', 'Confidence'],
            decisions.map((d) => [
                d.number,
                d.at.slice(11, 19),
                d.kind,
                d.summary,
                d.reason,
                d.confidence.toFixed(2),
            ]),
        ),
        decisions,
    );
}

export async function whatHappened(ctx: Ctx, zone: WatchZone) {
    const recent = (await ctx.memory.decisions({ zoneId: zone.id, limit: 60 })).toReversed();
    // The story starts at the last demo reset, if there was one.
    const reset = recent.findLastIndex((d) => d.kind === 'reset_demo');
    const decisions = recent.slice(reset + 1).slice(-25);
    if (!decisions.length) throw new AgentError(`no decisions logged for ${zone.name} yet`);
    const plan = await currentPlan(ctx, zone);
    const geo = await geography(ctx, zone.id);
    const facts = {
        decisions: decisions.map((d) => ({
            number: d.number,
            at: d.at,
            kind: d.kind,
            summary: d.summary,
            reason: d.reason,
            confidence: d.confidence,
        })),
        currentPlan: plan?.result ? planView(plan.result, geo) : null,
    };
    const fallback = decisions.map((d) => `${d.number}. ${d.summary}: ${d.reason}`).join('\n');
    return {
        text: await explain(ctx, 'What happened, and why? Tell it in order.', facts, fallback),
        card: decisionCard(decisions, `Decision log, ${zone.name}`),
    };
}
