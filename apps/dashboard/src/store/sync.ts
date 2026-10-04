import type { MappingRun, WatchZoneSummary } from '@ember/contracts';
import { useEffect } from 'react';
import { api } from '../api';
import { ApiError, message } from '../api/client';
import type { ZoneRecords } from '../model/types';
import { hectares, isActiveScan } from '../model/zone';
import { notify } from './notifications';
import { useZones } from './zones';

// Polls the api for what the open page shows and turns changes into notifications.

const TICK_MS = 2000;
const LIST_MS = 8000;

type Resource =
    | 'zone'
    | 'edgeServers'
    | 'placements'
    | 'drones'
    | 'scans'
    | 'runs'
    | 'riskZones'
    | 'surroundings'
    | 'plan'
    | 'blasts'
    | 'weather';

const EMPTY: Omit<ZoneRecords, 'zone'> = {
    edgeServers: [],
    placements: [],
    drones: [],
    scans: [],
    runs: [],
    riskZones: null,
    surroundings: null,
    planJobs: [],
    plan: null,
    blasts: [],
    weather: null,
};

function reachable(ok: boolean, err?: unknown): void {
    const was = useZones.getState().reachable;
    if (ok === was) return;
    if (!ok && !(err instanceof ApiError && err.status === 0)) return;
    useZones.setState({ reachable: ok });
    if (ok) notify('success', 'Connected to the Ember api again');
    else notify('critical', 'Cannot reach the Ember api', message(err));
}

function mergeRuns(known: MappingRun[], fresh: MappingRun[]): MappingRun[] {
    const key = (r: MappingRun) => `${r.runId}\n${r.edgeServerId}`;
    const byKey = new Map(known.map((r) => [key(r), r]));
    for (const r of fresh) byKey.set(key(r), r);
    return [...byKey.values()];
}

async function fetchResource(
    zoneId: string,
    resource: Resource,
    signal: AbortSignal,
): Promise<Partial<ZoneRecords>> {
    const current = useZones.getState().records[zoneId];
    switch (resource) {
        case 'zone': {
            const zone = await api.zone(zoneId, signal);
            // Keep the boundary's identity while it is unchanged: the zone's grid and every
            // overlay built on it are cached by it.
            const known = current?.zone.boundary;
            if (known && JSON.stringify(known) === JSON.stringify(zone.boundary))
                return { zone: { ...zone, boundary: known } };
            return { zone };
        }
        case 'edgeServers':
            return { edgeServers: await api.edgeServers({ zoneId }, signal) };
        case 'placements':
            return { placements: await api.placements(zoneId, signal) };
        case 'drones':
            return { drones: await api.drones(zoneId, signal) };
        case 'scans':
            return { scans: await api.scans(zoneId, 10, signal) };
        case 'runs': {
            const active = current?.scans.find((s) => isActiveScan(s));
            if (active && current) {
                const fresh = await api.mappingRuns({ runId: active.runId, limit: 100 }, signal);
                return { runs: mergeRuns(useZones.getState().records[zoneId]?.runs ?? [], fresh) };
            }
            return { runs: await api.mappingRuns({ zoneId, limit: 200 }, signal) };
        }
        case 'riskZones':
            return { riskZones: await api.riskZones(zoneId, signal) };
        case 'surroundings':
            return { surroundings: await api.surroundings(zoneId, signal) };
        case 'plan': {
            const planJobs = await api.plannerJobs(zoneId, 5, signal);
            const done = planJobs.find((j) => j.state === 'succeeded');
            if (!done) return { planJobs, plan: null };
            if (current?.plan?.jobId === done.jobId) return { planJobs };
            return { planJobs, plan: await api.plannerJob(done.jobId, signal) };
        }
        case 'blasts':
            return { blasts: await api.blasts(zoneId, signal) };
        case 'weather':
            return { weather: (await api.weather(zoneId, signal)).weather };
    }
}

function announce(prev: ZoneRecords, next: ZoneRecords): void {
    const zone = { id: next.zone.id, name: next.zone.name };
    for (const scan of next.scans) {
        const before = prev.scans.find((s) => s.runId === scan.runId);
        if (before?.state === scan.state) continue;
        if (!before && scan.requestedBy === 'schedule' && isActiveScan(scan))
            notify('info', 'Scheduled scan started', zone.name, zone);
        if (!before) continue;
        if (scan.state === 'done')
            notify(
                'success',
                'Scan complete',
                `${zone.name}: ${Math.round(scan.coverage * 100)}% of the run mapped.`,
                zone,
            );
        else if (scan.state === 'failed')
            notify('critical', 'Scan failed', scan.error ?? zone.name, zone);
    }
    if (prev.riskZones && next.riskZones) {
        const seen = new Set(prev.riskZones.riskZones.map((z) => z.id));
        const fresh = next.riskZones.riskZones.filter((z) => !seen.has(z.id));
        const fire = fresh.filter((z) => z.risk === 'on_fire');
        const risk = fresh.filter((z) => z.risk === 'at_risk');
        if (fire.length) {
            const ha = fire.reduce((s, z) => s + z.areaM2, 0) / 10_000;
            notify(
                'critical',
                'Fire detected',
                `${hectares(ha)} ha burning in ${zone.name}.`,
                zone,
            );
        }
        if (risk.length)
            notify(
                'warning',
                'At-risk area found',
                `${risk.length} new at-risk area${risk.length === 1 ? '' : 's'} in ${zone.name}.`,
                zone,
            );
    }
    const job = next.planJobs[0];
    const jobBefore = job && prev.planJobs.find((j) => j.jobId === job.jobId);
    if (job && jobBefore && jobBefore.state !== job.state) {
        if (job.state === 'succeeded') notify('success', 'Path plans ready', '', zone);
        else if (job.state === 'failed')
            notify('critical', 'Planner failed', job.message ?? '', zone);
    }
    for (const e of next.edgeServers) {
        const before = prev.edgeServers.find((x) => x.edgeServerId === e.edgeServerId);
        const was = before?.live?.online;
        const is = e.live?.online;
        if (was === undefined || is === undefined || was === is) continue;
        notify(
            is ? 'success' : 'warning',
            `Edge server ${e.name ?? e.edgeServerId} ${is ? 'online' : 'offline'}`,
            '',
            zone,
        );
    }
    const knownDrones = new Set(prev.drones.map((d) => d.droneId));
    const paired = next.drones.filter((d) => !knownDrones.has(d.droneId));
    if (prev.drones.length || prev.edgeServers.length)
        for (const d of paired)
            notify('success', 'Drone paired', `${d.name ?? d.droneId} joined ${zone.name}.`, zone);
}

class ZoneSync {
    private readonly controller = new AbortController();
    private readonly inFlight = new Set<Resource>();
    private timer = 0;
    private retry = 0;
    private tick = 0;
    private wasScanning = false;
    // Notices are for changes seen while the page is open, not for what the first load finds.
    private loaded = false;

    constructor(
        private readonly zoneId: string,
        private readonly withUnassigned: boolean,
    ) {}

    /**
     * Loads every resource before showing the zone, so the page opens on complete records (its
     * default overlay depends on past scans), then polls.
     */
    async start(): Promise<void> {
        const { signal } = this.controller;
        let zone: ZoneRecords['zone'];
        try {
            zone = await api.zone(this.zoneId, signal);
            reachable(true);
        } catch (err) {
            if (signal.aborted) return;
            if (err instanceof ApiError && err.status === 404) {
                useZones.setState((s) => ({ missing: { ...s.missing, [this.zoneId]: true } }));
                return;
            }
            reachable(false, err);
            this.retry = window.setTimeout(() => void this.start(), TICK_MS * 2);
            return;
        }
        const resources: Resource[] = [
            'scans',
            'edgeServers',
            'placements',
            'drones',
            'surroundings',
            'plan',
            'blasts',
            'weather',
            'runs',
            'riskZones',
        ];
        const results = await Promise.allSettled(
            resources.map((r) => fetchResource(this.zoneId, r, signal)),
        );
        if (signal.aborted) return;
        const known = useZones.getState().records[this.zoneId];
        const records: ZoneRecords = { ...(known ?? EMPTY), zone };
        for (const result of results)
            if (result.status === 'fulfilled') Object.assign(records, result.value);
            else reachable(false, result.reason);
        useZones.setState((s) => ({ records: { ...s.records, [this.zoneId]: records } }));
        this.loaded = true;
        this.wasScanning = this.scanning();
        if (this.withUnassigned) void unassigned(signal);
        this.timer = window.setInterval(() => this.step(), TICK_MS);
    }

    stop(): void {
        this.controller.abort();
        window.clearInterval(this.timer);
        window.clearTimeout(this.retry);
    }

    private scanning(): boolean {
        return Boolean(
            useZones.getState().records[this.zoneId]?.scans.some((s) => isActiveScan(s)),
        );
    }

    private step(): void {
        this.tick += 1;
        const r = useZones.getState().records[this.zoneId];
        if (!r) return;
        const scanning = this.scanning();
        const want: Resource[] = ['scans', 'edgeServers', 'drones'];
        if (scanning || this.wasScanning) want.push('runs', 'riskZones');
        else if (this.tick % 3 === 0) want.push('riskZones');
        if (this.tick % 3 === 0) want.push('placements', 'zone', 'blasts');
        const planning =
            r.planJobs[0] && ['queued', 'gathering', 'planning'].includes(r.planJobs[0].state);
        if (planning || this.tick % 6 === 0) want.push('plan');
        if (r.surroundings?.status === 'pending' && this.tick % 2 === 0) want.push('surroundings');
        if (this.tick % 300 === 0) want.push('weather');
        this.wasScanning = scanning;
        void this.fetch(want);
        if (this.withUnassigned) void unassigned(this.controller.signal);
    }

    async fetch(resources: Resource[]): Promise<void> {
        const { signal } = this.controller;
        const todo = resources.filter((r) => !this.inFlight.has(r));
        todo.forEach((r) => this.inFlight.add(r));
        const results = await Promise.allSettled(
            todo.map((r) =>
                fetchResource(this.zoneId, r, signal).finally(() => this.inFlight.delete(r)),
            ),
        );
        if (signal.aborted) return;
        const changes: Partial<ZoneRecords> = {};
        results.forEach((result, i) => {
            if (result.status === 'fulfilled') Object.assign(changes, result.value);
            else if (
                todo[i] === 'zone' &&
                result.reason instanceof ApiError &&
                result.reason.status === 404
            )
                useZones.setState((s) => ({ missing: { ...s.missing, [this.zoneId]: true } }));
            else reachable(false, result.reason);
        });
        if (results.some((r) => r.status === 'fulfilled')) reachable(true);
        const prev = useZones.getState().records[this.zoneId];
        if (!prev || Object.keys(changes).length === 0) return;
        useZones.getState().patch(this.zoneId, changes);
        const next = useZones.getState().records[this.zoneId];
        if (next && this.loaded) announce(prev, next);
    }
}

let unassignedBusy = false;

async function unassigned(signal: AbortSignal): Promise<void> {
    if (unassignedBusy) return;
    unassignedBusy = true;
    try {
        const list = await api.edgeServers({ unassigned: true }, signal);
        useZones.setState({ unassigned: list });
    } catch {
        // The zone's own polling reports an unreachable api.
    } finally {
        unassignedBusy = false;
    }
}

const syncs = new Map<string, ZoneSync>();

/** Keeps one zone's records fresh while the calling page is mounted. */
export function useZoneSync(zoneId: string | null, opts: { unassigned?: boolean } = {}): void {
    const withUnassigned = Boolean(opts.unassigned);
    useEffect(() => {
        if (!zoneId) return;
        const sync = new ZoneSync(zoneId, withUnassigned);
        syncs.set(zoneId, sync);
        void sync.start();
        return () => {
            sync.stop();
            if (syncs.get(zoneId) === sync) syncs.delete(zoneId);
        };
    }, [zoneId, withUnassigned]);
}

/** Fetches these resources of an open zone now, after an action changed them. */
export async function refresh(zoneId: string, ...resources: Resource[]): Promise<void> {
    await syncs.get(zoneId)?.fetch(resources);
}

function announceList(prev: WatchZoneSummary[], next: WatchZoneSummary[]): void {
    for (const z of next) {
        const before = prev.find((p) => p.id === z.id);
        if (before && z.summary.riskZones.onFire > before.summary.riskZones.onFire)
            notify('critical', 'Fire detected', z.name, z);
    }
}

/** The zone list, polled while the calling page is mounted. */
export function useZoneList(): void {
    useEffect(() => {
        const controller = new AbortController();
        const load = async () => {
            try {
                const summaries = await api.summaries(controller.signal);
                const prev = useZones.getState().summaries;
                useZones.setState({ summaries, listError: null });
                reachable(true);
                if (prev) announceList(prev, summaries);
            } catch (err) {
                if (controller.signal.aborted) return;
                useZones.setState({ listError: message(err) });
                reachable(false, err);
            }
        };
        void load();
        const timer = window.setInterval(() => void load(), LIST_MS);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, []);
}
