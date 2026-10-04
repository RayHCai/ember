import type { WatchZone } from '@ember/contracts';
import { areaAlert, duration, leadEvacuation, wayOut } from './alerts.js';
import type { Api } from './api.js';
import type { CivilianTransport } from './channels.js';
import type { Log } from './incidents.js';
import { renderMapPng, type TileSource } from './map.js';
import { REROUTE_BY } from './reroute.js';

export type NoticeDeps = {
    api: Api;
    transport: CivilianTransport;
    /** E.164; the operator's own phone, never one read from civilians. */
    phone: string;
    log: Log;
    /** Street map tiles under the route image. */
    tiles: TileSource;
    /** IANA zone the alert times are written in. */
    timeZone: string;
    now?: () => Date;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Texts the operator's notify phone each plan that succeeds, and nothing before it: when and how to
 * leave the area fire reaches first, then that route on a map, both ready before either is sent.
 * Like the dashboard, it announces plans that succeed while running, not what the first look finds.
 * It runs on its own short tick, apart from the incident loop, so a slow ZIP lookup or civilian
 * delivery never holds a plan text back.
 */
export class Notices {
    /** Each zone's plan last texted, or found at the first look; null for none. */
    private readonly planSeen = new Map<string, string | null>();
    /** Zones listed at the first look; one added later starts empty, so its first plan is news. */
    private initial: Set<string> | null = null;
    private readonly now: () => Date;
    private running = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly deps: NoticeDeps) {
        this.now = deps.now ?? (() => new Date());
    }

    start(tickMs: number) {
        this.running = true;
        const loop = async () => {
            await this.watch();
            if (this.running) this.timer = setTimeout(loop, tickMs);
        };
        void loop();
    }

    stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
    }

    /** One look at every zone at once, texting each newly succeeded plan. */
    async watch(): Promise<void> {
        const { api, log } = this.deps;
        let zones: WatchZone[];
        try {
            zones = await api.zones();
        } catch (err) {
            log.warn({ err: errorText(err) }, 'notices: watch zones unreadable');
            return;
        }
        this.initial ??= new Set(zones.map((z) => z.id));
        await Promise.all(
            zones.map((zone) =>
                this.plans(zone).catch((err: unknown) =>
                    log.warn({ zoneId: zone.id, err: errorText(err) }, 'notices failed'),
                ),
            ),
        );
    }

    private async plans(zone: WatchZone) {
        const jobs = await this.deps.api.plannerJobs(zone.id);
        const done =
            jobs
                .filter((j) => j.state === 'succeeded')
                .toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] ?? null;
        if (!this.planSeen.has(zone.id) && this.initial?.has(zone.id)) {
            this.planSeen.set(zone.id, done?.jobId ?? null);
            return;
        }
        if (!done || done.jobId === this.planSeen.get(zone.id)) return;
        // A plan whose text failed stays unseen, so the next tick tries it again.
        if (await this.plan(zone, done.jobId, done.requestedBy === REROUTE_BY)) {
            this.planSeen.set(zone.id, done.jobId);
        }
    }

    /**
     * Texts the plan for the area fire reaches first: the latest time to leave and the road out,
     * then that route on a street map. The map is drawn before anything is sent. A plan asked for
     * by a new-route text is marked as another way out. True once the text is delivered.
     */
    private async plan(zone: WatchZone, jobId: string, alternate: boolean) {
        const { api, transport, phone } = this.deps;
        const result = (await api.plannerJob(jobId)).result;
        if (!result) return true;
        const s = await api.surroundings(zone.id);
        const lead = leadEvacuation(result);
        const info = { zoneId: zone.id, kind: 'plan', jobId };
        if (!lead) {
            const body = `Ember Alert: the fire is not expected to reach a community in the next ${duration(result.horizonMin)}. No evacuation needed now.`;
            return this.deliver(() => transport.send(phone, body), info);
        }
        const body = areaAlert(
            lead,
            s,
            result.generatedAt,
            this.now(),
            this.deps.timeZone,
            alternate,
        );
        let map: Buffer | null = null;
        if (wayOut(lead, s)) {
            const onFire = (await api.riskZones(zone.id)).riskZones.filter(
                (z) => z.risk === 'on_fire',
            );
            const area = s.civilianAreas.find((a) => a.id === lead.impact.civilianAreaId);
            map = await renderMapPng(
                { surroundings: s, zone, route: lead.route!, from: area ?? null, onFire },
                this.deps.tiles,
            );
        }
        if (!(await this.deliver(() => transport.send(phone, body), info))) return false;
        if (map) {
            const png = map;
            await this.deliver(
                () => transport.sendImage(phone, png, 'image/png', 'ember-evacuation-route.png'),
                { ...info, kind: 'plan_map' },
            );
        }
        return true;
    }

    private async deliver(send: () => Promise<void>, info: Record<string, unknown>) {
        try {
            await send();
            this.deps.log.info({ ...info, transport: this.deps.transport.name }, 'notice texted');
            return true;
        } catch (err) {
            this.deps.log.warn({ ...info, err: errorText(err) }, 'notice not delivered');
            return false;
        }
    }
}
