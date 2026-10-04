import type {
    AgentCard,
    DetectionRecord,
    PlannerJobView,
    Scan,
    SectorRisk,
    WatchZone,
} from '@ember/contracts';
import { card, table } from '../cards.js';
import { AgentError, decide, describeError, EMBER, runPlanner, type Ctx } from '../context.js';
import { scanInterval, triage } from '../policy.js';
import { escalate } from './response.js';

/** The newest plan of the zone if fresh enough, else a new one. */
export async function riskPlan(
    ctx: Ctx,
    zone: WatchZone,
    opts: { maxAgeMin?: number; reason: string; actor?: string },
): Promise<PlannerJobView> {
    const latest = await ctx.api.latestPlan(zone.id);
    const maxAge = (opts.maxAgeMin ?? ctx.config.riskPlanMaxAgeMin) * 60_000;
    if (latest?.result && ctx.now().getTime() - Date.parse(latest.result.generatedAt) < maxAge) {
        return latest;
    }
    const view = await runPlanner(ctx, zone.id, {
        reason: opts.reason,
        requestedBy: opts.actor ?? EMBER,
    });
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: null,
        domain: 'prevention',
        kind: 'risk_plan',
        summary: `Refreshed the risk plan for ${zone.name}`,
        reason: opts.reason,
        inputs: [{ kind: 'planner_job', id: view.job.jobId, note: 'new plan' }],
        confidence: 1,
        actions: [`POST /v1/watch-zones/${zone.id}/planner-jobs -> ${view.job.jobId}`],
    });
    return view;
}

export function rankingCard(zone: WatchZone, sectors: SectorRisk[], jobId: string): AgentCard {
    const rows = sectors
        .slice(0, 8)
        .map((s) => [
            s.id,
            s.score.toFixed(2),
            s.band,
            s.drivers.slice(0, 3).join('; '),
            s.population,
        ]);
    return card(
        'risk_ranking',
        `Wildfire risk by sector, ${zone.name}`,
        table(['Sector', 'Score', 'Band', 'Main factors', 'People nearby'], rows),
        { zoneId: zone.id, jobId, sectors: sectors.slice(0, 8) },
        sectors[0]
            ? [{ label: `Scan ${sectors[0].id}`, reply: `Begin surveillance of ${sectors[0].id}` }]
            : [],
    );
}

/** Half the sector's diagonal: a scan circle that covers it. */
function sectorRadiusM(s: SectorRisk): number {
    const rad = Math.PI / 180;
    let max = 0;
    for (const p of s.polygon) {
        const x = (p.lng - s.center.lng) * rad * Math.cos(s.center.lat * rad);
        max = Math.max(max, Math.hypot(x, (p.lat - s.center.lat) * rad) * 6_371_008.8);
    }
    return Math.max(200, Math.round(max));
}

export async function startSurveillance(
    ctx: Ctx,
    zone: WatchZone,
    opts: { sectorIds?: string[]; reason: string; actor: string },
): Promise<{ scan: Scan; intervalMin: number; sectors: SectorRisk[]; card: AgentCard }> {
    const view = await riskPlan(ctx, zone, {
        reason: 'surveillance needs current sector risk',
        actor: opts.actor,
    });
    const all = view.result!.sectorRisks;
    const wanted = opts.sectorIds?.length
        ? all.filter((s) => opts.sectorIds!.some((id) => id.toLowerCase() === s.id.toLowerCase()))
        : all.slice(0, 1);
    if (!wanted.length) {
        throw new AgentError(
            `no sector ${opts.sectorIds?.join(', ')} in ${zone.name}; sectors run S1 to S${all.length}`,
        );
    }
    const [weather, detections, incidents] = await Promise.all([
        ctx.api.weather(zone.id),
        ctx.api.detections(zone.id),
        ctx.api.incidents(zone.id),
    ]);
    const cadence = scanInterval({
        topSectorScore: all[0]?.score ?? null,
        weather: weather.weather,
        openDetections: detections.filter(
            (d) => d.verification === 'unverified' || d.verification === 'verifying',
        ).length,
        activeIncident: incidents.some((i) => i.state === 'active'),
    });
    const target = wanted[0]!;
    const scan = await ctx.api.startScan(zone.id, {
        purpose: 'surveillance',
        reason: `${opts.reason} (${target.id}, score ${target.score.toFixed(2)})`,
        requestedBy: opts.actor,
        focus: { center: target.center, radiusM: sectorRadiusM(target) },
    });
    await ctx.api.setSurveillance(zone.id, {
        intervalMin: cadence.intervalMin,
        priorities: wanted.map((s) => s.id),
        reason: cadence.reasons.join('; '),
        setBy: opts.actor,
    });
    await ctx.memory.setState(`lastScan:${zone.id}`, ctx.now().toISOString());
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: null,
        domain: 'prevention',
        kind: 'surveillance',
        summary: `Scanning ${wanted.map((s) => s.id).join(', ')} of ${zone.name}; next scans every ${cadence.intervalMin} min`,
        reason: `${opts.reason}. Cadence: ${cadence.reasons.join('; ')}`,
        inputs: [
            {
                kind: 'planner_job',
                id: view.job.jobId,
                note: `sector ${target.id} score ${target.score}`,
            },
            {
                kind: 'weather',
                id: weather.fetchedAt,
                note: weather.weather?.source ?? 'no weather',
            },
            { kind: 'scan', id: scan.runId, note: scan.state },
        ],
        confidence: 0.8,
        actions: [`POST /v1/watch-zones/${zone.id}/scans -> ${scan.runId} (${scan.state})`],
    });
    const status =
        scan.state === 'failed'
            ? `The edge plane did not start the run: ${scan.error}.`
            : `Run ${scan.runId.slice(0, 8)} is mapping with ${scan.edgeServerIds.join(', ')}.`;
    return {
        scan,
        intervalMin: cadence.intervalMin,
        sectors: wanted,
        card: card(
            'scan',
            `Surveillance: ${zone.name} ${wanted.map((s) => s.id).join(', ')}`,
            `${status}\n\nCadence: every ${cadence.intervalMin} min (${cadence.reasons.join('; ')}).`,
            { scan, intervalMin: cadence.intervalMin },
        ),
    };
}

export async function requestVerification(
    ctx: Ctx,
    zone: WatchZone,
    d: DetectionRecord,
    reason: string,
): Promise<Scan | null> {
    await ctx.api.verifyDetection(d.id, 'verifying', EMBER);
    let scan: Scan | null = null;
    let note: string;
    try {
        scan = await ctx.api.startScan(zone.id, {
            purpose: 'verification',
            reason: `verify detection ${d.id}: ${reason}`,
            requestedBy: EMBER,
            focus: { center: d.center, radiusM: 400 },
        });
        note = scan.state === 'failed' ? `scan failed: ${scan.error}` : `scan ${scan.runId}`;
    } catch (err) {
        note = `scan not started: ${describeError(err)}`;
    }
    if (d.source === 'simulated') {
        await ctx.memory.setState(`simverify:${d.id}`, {
            zoneId: zone.id,
            due: ctx.now().toISOString(),
        });
        note += '; simulated fire, so the simulation supplies the second look';
    }
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: null,
        domain: 'prevention',
        kind: 'verify_detection',
        summary: `Requested a verification scan of detection ${d.id} (${d.risk}, ${d.confidence.toFixed(2)})`,
        reason,
        inputs: [{ kind: 'detection', id: d.id, note: `${d.source}, confidence ${d.confidence}` }],
        confidence: d.confidence,
        actions: [note],
    });
    return scan;
}

/** The loop and chat both route every new detection through here. */
export async function evaluateDetection(
    ctx: Ctx,
    zone: WatchZone,
    d: DetectionRecord,
    all: DetectionRecord[],
): Promise<string> {
    const t = triage(d, all, ctx.config);
    if (t.action === 'confirm') {
        const ids = new Set([d.id, ...t.corroboratedBy]);
        const incident = await escalate(
            ctx,
            zone,
            all.filter((x) => ids.has(x.id)),
            t.reason,
            t.confidence,
        );
        return `confirmed (${t.reason}); Incident #${incident.number}`;
    }
    if (t.action === 'verify') {
        await requestVerification(ctx, zone, d, t.reason);
        return `verification scan requested (${t.reason})`;
    }
    if (t.action === 'watch') {
        const key = `watched:${d.id}`;
        if (!(await ctx.memory.getState(key))) {
            await ctx.memory.setState(key, true);
            await decide(ctx, {
                zoneId: zone.id,
                incidentId: null,
                domain: 'prevention',
                kind: 'watch_detection',
                summary: `Watching low-confidence detection ${d.id}`,
                reason: t.reason,
                inputs: [{ kind: 'detection', id: d.id, note: d.source }],
                confidence: t.confidence,
                actions: [],
            });
        }
        return `watching (${t.reason})`;
    }
    return t.reason;
}

/**
 * A simulation-only fire, placed in a sector or at a point. It is recorded with source
 * `simulated` and goes through the same triage as a drone detection.
 */
export async function simulateFire(
    ctx: Ctx,
    zone: WatchZone,
    opts: {
        sectorId?: string;
        location?: { lat: number; lng: number };
        confidence?: number;
        actor: string;
    },
): Promise<{ detection: DetectionRecord; outcome: string }> {
    let center = opts.location;
    let where = center ? `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}` : '';
    if (!center) {
        const view = await riskPlan(ctx, zone, {
            reason: 'placing a simulated fire by sector',
            actor: opts.actor,
        });
        const sectors = view.result!.sectorRisks;
        const sector = opts.sectorId
            ? sectors.find(
                  (s) =>
                      s.id.toLowerCase() ===
                      opts.sectorId!.toLowerCase().replace(/^sector\s*/, 's'),
              )
            : sectors[0];
        if (!sector) {
            throw new AgentError(
                `no sector ${opts.sectorId} in ${zone.name}; sectors run S1 to S${sectors.length}`,
            );
        }
        center = sector.center;
        where = `sector ${sector.id}`;
    }
    const detection = await ctx.api.simulateDetection(zone.id, {
        center,
        radiusM: 120,
        risk: 'on_fire',
        confidence: opts.confidence ?? 0.6,
        requestedBy: opts.actor,
    });
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: null,
        domain: 'prevention',
        kind: 'simulate_fire',
        summary: `Simulated a fire in ${where} of ${zone.name}`,
        reason: `requested by ${opts.actor}; simulation-only, no real fire`,
        inputs: [
            {
                kind: 'detection',
                id: detection.id,
                note: `simulated, confidence ${detection.confidence}`,
            },
        ],
        confidence: 1,
        actions: [`POST /v1/watch-zones/${zone.id}/detections/simulated -> ${detection.id}`],
    });
    const all = await ctx.api.detections(zone.id);
    const outcome = await evaluateDetection(ctx, zone, detection, all);
    return { detection, outcome };
}

/** Simulated fires get their second look from the simulation once a verification was asked. */
export async function completeSimulatedVerifications(ctx: Ctx, zone: WatchZone): Promise<void> {
    const pending = await ctx.api.detections(zone.id, { verification: 'verifying' });
    for (const d of pending.filter((x) => x.source === 'simulated')) {
        const key = `simverify:${d.id}`;
        const state = await ctx.memory.getState<{ due: string }>(key);
        if (!state || Date.parse(state.due) > ctx.now().getTime()) continue;
        await ctx.memory.setState(key, null);
        const second = await ctx.api.simulateDetection(zone.id, {
            center: d.center,
            radiusM: 150,
            risk: 'on_fire',
            confidence: 0.9,
            requestedBy: `${EMBER} (simulated verification pass)`,
        });
        const all = await ctx.api.detections(zone.id);
        await evaluateDetection(ctx, zone, second, all);
    }
}
