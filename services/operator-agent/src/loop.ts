import type { FieldReport, Weather, WatchZone } from '@ember/contracts';
import { handleInbound } from './civilian.js';
import { decide, describeError, EMBER, type Ctx } from './context.js';
import { parseObservation } from './observations.js';
import { scanInterval } from './policy.js';
import { handleRoadReport, openIncidents, sendApproved } from './playbooks/response.js';
import {
    completeSimulatedVerifications,
    evaluateDetection,
    startSurveillance,
} from './playbooks/surveillance.js';

/** Wind or humidity moving this much since the last plan is a change in conditions. */
const WIND_CHANGE_MPS = 3;
const HUMIDITY_CHANGE_PCT = 10;
/** A queued job this old means the planner is not consuming the queue. */
const STALE_JOB_MS = 5 * 60_000;

function conditionsChanged(before: Weather | null, now: Weather | null): string | null {
    if (!now) return null;
    if (!before) return 'first weather reading';
    const reasons: string[] = [];
    if (Math.abs(now.windSpeedMps - before.windSpeedMps) >= WIND_CHANGE_MPS) {
        reasons.push(`wind ${before.windSpeedMps} → ${now.windSpeedMps} m/s`);
    }
    if (
        now.relativeHumidityPct !== null &&
        before.relativeHumidityPct !== null &&
        Math.abs(now.relativeHumidityPct - before.relativeHumidityPct) >= HUMIDITY_CHANGE_PCT
    ) {
        reasons.push(`humidity ${before.relativeHumidityPct} → ${now.relativeHumidityPct}%`);
    }
    if (now.redFlagWarning && !before.redFlagWarning) reasons.push('red flag warning issued');
    return reasons.length ? reasons.join(', ') : null;
}

/**
 * OBSERVE → UPDATE → ASSESS → PLAN → ACT → MONITOR, once per tick. Each step reads the api,
 * decides by policy, logs the decision and acts through the api. One step failing does not
 * stop the others; ticks never overlap.
 */
export class MasterLoop {
    private running = false;
    /** For health: when the last tick finished, and whether it reached the api. */
    lastTick: { at: string; ok: boolean; zones: number; error: string | null } | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly ctx: Ctx) {}

    start() {
        this.timer = setInterval(() => void this.tick(), this.ctx.config.tickMs);
        void this.tick();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async step(name: string, fn: () => Promise<unknown>) {
        try {
            await fn();
        } catch (err) {
            this.ctx.log.warn({ step: name, err: describeError(err) }, 'loop step failed');
        }
    }

    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        let zones: Awaited<ReturnType<Ctx['api']['zones']>> = [];
        let error: string | null = null;
        try {
            zones = await this.ctx.api.zones();
            await this.step('send approved alerts', () => sendApproved(this.ctx));
            await this.step('civilian messages', () => this.civilianMessages());
            for (const zone of zones) {
                await this.step(`${zone.name}: pending plans`, () => this.pendingPlans(zone));
                await this.step(`${zone.name}: conditions`, () => this.conditions(zone));
                await this.step(`${zone.name}: simulated verification`, () =>
                    completeSimulatedVerifications(this.ctx, zone),
                );
                await this.step(`${zone.name}: detections`, () => this.detections(zone));
                await this.step(`${zone.name}: reports`, () => this.reports(zone));
                await this.step(`${zone.name}: surveillance`, () => this.surveillance(zone));
            }
        } catch (err) {
            error = describeError(err);
            this.ctx.log.warn({ err: error }, 'tick failed');
        } finally {
            this.running = false;
            this.lastTick = {
                at: this.ctx.now().toISOString(),
                ok: !error,
                zones: zones.length,
                error,
            };
        }
    }

    private async civilianMessages() {
        const { ctx } = this;
        const key = 'cursor:civilianInbound';
        const since =
            (await ctx.memory.getState<string>(key)) ??
            new Date(ctx.now().getTime() - 60 * 60_000).toISOString();
        const inbound = await ctx.api.civilianMessages({ direction: 'inbound', since });
        for (const m of inbound) {
            await this.step(`civilian message ${m.id}`, () => handleInbound(ctx, m));
            await ctx.memory.setState(key, m.createdAt);
        }
    }

    /** Risk plans enqueued without waiting: note when they land, or when the planner is down. */
    private async pendingPlans(zone: WatchZone) {
        const { ctx } = this;
        for (const p of (await ctx.memory.pending()).filter((x) => x.zoneId === zone.id)) {
            const view = await ctx.api.plan(p.jobId);
            if (view.job.state === 'succeeded' || view.job.state === 'failed') {
                await ctx.memory.removePending(p.jobId);
                const top = view.result?.sectorRisks[0];
                await decide(ctx, {
                    zoneId: zone.id,
                    incidentId: p.incidentId,
                    domain: 'prevention',
                    kind: 'risk_plan',
                    summary:
                        view.job.state === 'succeeded'
                            ? `Risk plan ready for ${zone.name}${top ? `: top sector ${top.id} at ${top.score.toFixed(2)} (${top.band})` : ''}`
                            : `Risk plan for ${zone.name} failed: ${view.job.message}`,
                    reason: p.data.reason ?? 'scheduled',
                    inputs: [{ kind: 'planner_job', id: p.jobId, note: view.job.state }],
                    confidence: 1,
                    actions: [],
                });
            } else if (
                ctx.now().getTime() - Date.parse(view.job.requestedAt) > STALE_JOB_MS &&
                !p.data.stale
            ) {
                await ctx.memory.addPending({ ...p, data: { ...p.data, stale: 'true' } });
                ctx.log.warn(
                    { jobId: p.jobId, state: view.job.state },
                    'planner has not picked up the job; is it running?',
                );
            }
        }
    }

    /** Weather moved enough, or the risk plan is old: ask the planner again. */
    private async conditions(zone: WatchZone) {
        const { ctx } = this;
        const { weather } = await ctx.api.weather(zone.id);
        const key = `weather:${zone.id}`;
        const before = await ctx.memory.getState<Weather>(key);
        const changed = conditionsChanged(before, weather);
        const latest = await ctx.api.latestPlan(zone.id);
        const age = latest?.result
            ? ctx.now().getTime() - Date.parse(latest.result.generatedAt)
            : Infinity;
        const stale = age > ctx.config.riskPlanMaxAgeMin * 60_000;
        if (!changed && !stale) return;
        if (changed) await ctx.memory.setState(key, weather);
        const pending = (await ctx.memory.pending()).some(
            (p) => p.zoneId === zone.id && p.kind === 'risk',
        );
        if (pending || (await openIncidents(ctx, zone.id)).some((i) => i.state === 'active'))
            return;
        const reason = changed
            ? `conditions changed: ${changed}`
            : 'risk plan older than its refresh age';
        const job = await ctx.api.enqueuePlan(zone.id, { requestedBy: EMBER, reason });
        await ctx.memory.addPending({
            jobId: job.jobId,
            zoneId: zone.id,
            kind: 'risk',
            incidentId: null,
            data: { reason },
            createdAt: ctx.now().toISOString(),
        });
    }

    private async detections(zone: WatchZone) {
        const { ctx } = this;
        const all = await ctx.api.detections(zone.id);
        const open = all.filter(
            (d) => d.verification === 'unverified' || d.verification === 'verifying',
        );
        for (const d of open.toSorted((a, b) => b.confidence - a.confidence)) {
            const fresh = await ctx.api.detection(d.id);
            if (fresh.verification === 'confirmed') continue;
            await evaluateDetection(ctx, zone, fresh, await ctx.api.detections(zone.id));
        }
    }

    private async reports(zone: WatchZone) {
        for (const report of await this.ctx.api.reports(zone.id, true)) {
            await this.step(`report ${report.id}`, () => this.report(zone, report));
        }
    }

    private async report(zone: WatchZone, report: FieldReport) {
        const { ctx } = this;
        const o = await parseObservation(ctx, report.text, report.reporterId);
        let note = `parsed as ${o.kind}`;
        if (o.kind === 'road' && o.roadName && o.roadState) {
            const replan = await handleRoadReport(ctx, zone, {
                roadName: o.roadName,
                state: o.roadState,
                source: report.source,
                reportedBy: report.reporterId,
                note: report.text,
            });
            note = `road ${replan.roadName} ${replan.state}; ${replan.newJobId ? `replanned ${replan.newJobId}` : 'no replan needed'}`;
        } else if (
            o.kind === 'responder_status' &&
            o.responderStatus &&
            report.reporterId.startsWith('responder:')
        ) {
            const id = report.reporterId.slice('responder:'.length);
            const status = o.responderStatus === 'unavailable' ? undefined : o.responderStatus;
            await ctx.api.updateResponder(id, {
                ...(status ? { status } : { availability: 'unavailable' }),
                ...(report.location ? { location: report.location } : {}),
            });
            note = `responder ${o.responderStatus}`;
        }
        await ctx.api.processReport(report.id, note);
    }

    /** Sets the scan cadence from risk and conditions, and starts a scan when one is due. */
    private async surveillance(zone: WatchZone) {
        const { ctx } = this;
        const [weather, detections, incidents, latest, scans, servers] = await Promise.all([
            ctx.api.weather(zone.id),
            ctx.api.detections(zone.id),
            openIncidents(ctx, zone.id),
            ctx.api.latestPlan(zone.id),
            ctx.api.scans(zone.id),
            ctx.api.edgeServers(zone.id),
        ]);
        const cadence = scanInterval({
            topSectorScore: latest?.result?.sectorRisks[0]?.score ?? null,
            weather: weather.weather,
            openDetections: detections.filter(
                (d) => d.verification === 'unverified' || d.verification === 'verifying',
            ).length,
            activeIncident: incidents.some((i) => i.state === 'active'),
        });
        const current = zone.surveillance?.intervalMin ?? null;
        if (current === null || Math.abs(cadence.intervalMin - current) / current > 0.25) {
            const priorities = latest?.result?.sectorRisks.slice(0, 3).map((s) => s.id) ?? [];
            await ctx.api.setSurveillance(zone.id, {
                intervalMin: cadence.intervalMin,
                priorities,
                reason: cadence.reasons.join('; '),
                setBy: EMBER,
            });
            await decide(ctx, {
                zoneId: zone.id,
                incidentId: null,
                domain: 'prevention',
                kind: 'scan_cadence',
                summary: `${zone.name}: scan every ${cadence.intervalMin} min${current ? ` (was ${current})` : ''}, priority ${priorities.join(', ') || 'whole zone'}`,
                reason: cadence.reasons.join('; '),
                inputs: [
                    {
                        kind: 'weather',
                        id: weather.fetchedAt,
                        note: weather.weather?.source ?? 'none',
                    },
                    ...(latest
                        ? [
                              {
                                  kind: 'planner_job' as const,
                                  id: latest.job.jobId,
                                  note: 'sector risk',
                              },
                          ]
                        : []),
                ],
                confidence: 0.75,
                actions: [`PUT /v1/watch-zones/${zone.id}/surveillance`],
            });
        }
        if (!servers.length || !latest?.result) return;
        if (scans.some((s) => s.state === 'mapping')) return;
        const last =
            scans[0]?.startedAt ?? (await ctx.memory.getState<string>(`lastScan:${zone.id}`));
        if (last && ctx.now().getTime() - Date.parse(last) < cadence.intervalMin * 60_000) return;
        await startSurveillance(ctx, zone, {
            reason: `scheduled: due every ${cadence.intervalMin} min`,
            actor: EMBER,
            sectorIds: latest.result.sectorRisks.slice(0, 1).map((s) => s.id),
        });
    }
}
