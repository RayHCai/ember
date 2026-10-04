import type {
    AttackZone,
    Blast,
    PlannerJob,
    PlannerJobState,
    PlannerResult,
    WatchZone,
} from '@ember/contracts';
import {
    evacuationBlast,
    evacuationsByZip,
    isResponderBrief,
    responderBlast,
    zipOfBlast,
} from './alerts.js';
import type { Api } from './api.js';
import type { CivilianTransport } from './channels.js';
import type { AgentConfig } from './config.js';
import type { ZipLookup } from './geo.js';

/** How the agent signs the planner jobs it requests. */
export const AGENT = 'operator-agent';

export type Log = {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
};

export type Evacuation = {
    blastId: string;
    zipCode: string;
    title: string;
    state: Blast['state'];
    /** Set once the approved text has gone out. */
    delivered: { sent: number; failed: number } | null;
};

/** What the agent last saw of one zone, for chat. */
export type ZoneStatus = {
    zone: WatchZone;
    /** On-fire risk zones; zero means no incident. */
    onFire: number;
    /** When the incident's first fire was seen; null without one. */
    since: string | null;
    plan: { jobId: string; state: PlannerJobState } | null;
    responders: AttackZone[];
    evacuations: Evacuation[];
    /** Areas told to leave whose ZIP could not be found, so no one in them was drafted. */
    unplaced: string[];
    checkedAt: string;
};

export type LoopDeps = {
    api: Api;
    transport: CivilianTransport;
    zipOf: ZipLookup;
    config: AgentConfig;
    log: Log;
    now?: () => Date;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Watches every zone through the api. A zone with fire is an incident: the agent requests one
 * plan for it, posts where responders should stage, drafts one evacuation alert per affected ZIP
 * for operator approval, and texts each approved alert to the civilians signed up in that ZIP.
 * Its progress is read back from the api's planner jobs and blasts, so a restart resumes it.
 */
export class IncidentLoop {
    readonly status = new Map<string, ZoneStatus>();
    lastTick: { at: string; ok: boolean } | null = null;

    private readonly delivered = new Map<string, { sent: number; failed: number }>();
    private readonly results = new Map<string, PlannerResult>();
    private readonly startedAt: number;
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private readonly now: () => Date;

    constructor(private readonly deps: LoopDeps) {
        this.now = deps.now ?? (() => new Date());
        this.startedAt = this.now().getTime();
    }

    start() {
        this.running = true;
        const loop = async () => {
            await this.tick();
            if (this.running) this.timer = setTimeout(loop, this.deps.config.tickMs);
        };
        void loop();
    }

    stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
    }

    async tick(): Promise<void> {
        let ok = true;
        try {
            const zones = await this.deps.api.zones();
            for (const zone of zones) {
                try {
                    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
                    await this.zone(zone);
                } catch (err) {
                    ok = false;
                    this.deps.log.warn(
                        { zoneId: zone.id, err: errorText(err) },
                        'zone check failed',
                    );
                }
            }
        } catch (err) {
            ok = false;
            this.deps.log.warn({ err: errorText(err) }, 'watch zones unreadable');
        }
        this.lastTick = { at: this.now().toISOString(), ok };
    }

    private async zone(zone: WatchZone) {
        const { api } = this.deps;
        const [view, blasts] = await Promise.all([api.riskZones(zone.id), api.blasts(zone.id)]);
        await this.deliver(blasts);

        const onFire = view.riskZones.filter((r) => r.risk === 'on_fire');
        const status: ZoneStatus = {
            zone,
            onFire: onFire.length,
            since: null,
            plan: null,
            responders: [],
            evacuations: [],
            unplaced: this.status.get(zone.id)?.unplaced ?? [],
            checkedAt: this.now().toISOString(),
        };
        this.status.set(zone.id, status);
        if (!onFire.length) {
            status.unplaced = [];
            return;
        }

        const since = onFire.map((r) => r.firstSeenAt).toSorted()[0]!;
        status.since = since;
        const ours = blasts.filter((b) => b.createdAt >= since);
        status.evacuations = this.evacuations(ours);

        const job = await this.plan(zone, since);
        status.plan = job && { jobId: job.jobId, state: job.state };
        if (job?.state !== 'succeeded') return;

        const result = await this.result(job.jobId);
        if (!result) return;
        status.responders = [...result.attackZones]
            .toSorted((a, b) => a.rank - b.rank)
            .slice(0, this.deps.config.responderZones);
        if (ours.some((b) => isResponderBrief(b.title))) return;

        status.unplaced = await this.notify(zone, result, ours);
        const drafted = await api.blasts(zone.id);
        status.evacuations = this.evacuations(drafted.filter((b) => b.createdAt >= since));
    }

    /** The incident's latest agent-requested plan, requesting one when there is none to wait on. */
    private async plan(zone: WatchZone, since: string): Promise<PlannerJob | null> {
        const { api, config, log } = this.deps;
        const jobs = (await api.plannerJobs(zone.id))
            .filter((j) => j.requestedBy === AGENT && j.requestedAt >= since)
            .toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt));
        const latest = jobs[0] ?? null;
        const retry =
            latest?.state === 'failed' &&
            this.now().getTime() - Date.parse(latest.updatedAt) >= config.planRetryMs;
        if (latest && !retry) return latest;
        const job = await api.requestPlan(zone.id, AGENT);
        log.info(
            { zoneId: zone.id, jobId: job.jobId, retry, since },
            'fire detected: plan requested',
        );
        return job;
    }

    private async result(jobId: string) {
        const cached = this.results.get(jobId);
        if (cached) return cached;
        const result = (await this.deps.api.plannerJob(jobId)).result ?? null;
        if (result) this.results.set(jobId, result);
        return result;
    }

    /**
     * Drafts an evacuation alert per ZIP not yet drafted this incident, then the responder brief.
     * The brief goes last: it marks the incident as notified, so a failure before it is retried.
     */
    private async notify(zone: WatchZone, result: PlannerResult, ours: Blast[]) {
        const { api, zipOf, config, log } = this.deps;
        const surroundings = await api.surroundings(zone.id);
        const zipOfArea = new Map<string, string | null>();
        for (const area of surroundings.civilianAreas) {
            const leaving = result.civilianImpacts.some(
                (i) =>
                    i.civilianAreaId === area.id &&
                    (i.severity === 'immediate' || i.severity === 'warning'),
            );
            // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
            if (leaving) zipOfArea.set(area.id, await zipOf(area.center).catch(() => null));
        }
        const { byZip, unplaced } = evacuationsByZip(result, zipOfArea);
        const drafted = new Set(ours.map((b) => zipOfBlast(b.title)).filter(Boolean));
        for (const e of byZip) {
            if (drafted.has(e.zipCode)) continue;
            // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
            const blast = await api.createBlast(
                zone.id,
                evacuationBlast(zone, e, surroundings, {
                    generatedAt: result.generatedAt,
                    now: this.now(),
                    timeZone: config.timeZone,
                    mapUrl: config.civilianMapUrl,
                }),
            );
            log.info(
                { zoneId: zone.id, blastId: blast.blastId, zipCode: e.zipCode, state: blast.state },
                'evacuation alert drafted for operator approval',
            );
        }
        if (unplaced.length) {
            log.warn(
                { zoneId: zone.id, areas: unplaced.map((i) => i.name) },
                'areas to evacuate have no known ZIP: no alert drafted for them',
            );
        }
        const brief = await api.createBlast(
            zone.id,
            responderBlast(zone, result, config.responderZones),
        );
        log.info(
            { zoneId: zone.id, blastId: brief.blastId, attackZones: result.attackZones.length },
            'responder staging posted',
        );
        return unplaced.map((i) => i.name);
    }

    private evacuations(blasts: Blast[]): Evacuation[] {
        return blasts.flatMap((b) => {
            const zipCode = zipOfBlast(b.title);
            return zipCode
                ? [
                      {
                          blastId: b.blastId,
                          zipCode,
                          title: b.title,
                          state: b.state,
                          delivered: this.delivered.get(b.blastId) ?? null,
                      },
                  ]
                : [];
        });
    }

    /**
     * Texts each operator-approved evacuation alert to every civilian in its ZIP, once. The
     * approval record is the api's: a blast is `queued` with an approval only after an operator
     * approved it.
     */
    private async deliver(blasts: Blast[]) {
        const { api, transport, config, log } = this.deps;
        const cutoff = this.startedAt - config.deliveryLookbackMin * 60_000;
        for (const b of blasts) {
            const zipCode = zipOfBlast(b.title);
            if (!zipCode || b.audience === 'responders') continue;
            if (b.state !== 'queued' || !b.approval || this.delivered.has(b.blastId)) continue;
            if (Date.parse(b.approval.approvedAt) < cutoff) {
                this.delivered.set(b.blastId, { sent: 0, failed: 0 });
                continue;
            }
            // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
            const civilians = await api.civiliansIn(zipCode);
            const tally = { sent: 0, failed: 0 };
            this.delivered.set(b.blastId, tally);
            for (const c of civilians) {
                try {
                    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
                    await transport.send(c.phone, b.body);
                    tally.sent++;
                } catch (err) {
                    tally.failed++;
                    log.warn(
                        { blastId: b.blastId, civilianId: c.id, err: errorText(err) },
                        'evacuation text not delivered',
                    );
                }
            }
            log.info(
                {
                    blastId: b.blastId,
                    zipCode,
                    approvedBy: b.approval.approverName,
                    transport: transport.name,
                    ...tally,
                },
                'approved evacuation alert sent',
            );
        }
    }
}
