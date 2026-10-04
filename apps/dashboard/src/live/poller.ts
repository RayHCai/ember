import type { PlannerJobView } from '@ember/contracts';
import { useEffect } from 'react';
import type { LatLon, RoadState, WatchZone } from '../sim/types';
import { notify } from '../store/notifications';
import { useRouter } from '../store/router';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';
import { useZones } from '../store/zones';
import {
    getActiveAssignments,
    getDetections,
    getEdgeServers,
    getGeography,
    getIncidents,
    getPendingApprovals,
    getPlannerJob,
    getPlannerJobs,
    getResponders,
    getRiskZones,
    getWatchZones,
    LiveApiError,
    postDecision,
    postRoadObservation,
    postSimulatedDetection,
} from './api';
import {
    activeHazards,
    communities,
    edgeServers,
    liveZone,
    liveZoneId,
    livePlans,
    openIncident,
    pendingAlerts,
    planJobId,
    responders,
    riskMap,
    roads,
    safeZones,
    type LiveAlert,
} from './map';
import { useLive } from './store';

// Keeps the one live watch zone in the zones store current by polling the api.

export const LIVE_ZONE_NAME = 'Lahaina';
/** While the live zone page is open. */
export const LIVE_POLL_MS = 3000;
/** While the zone list is open, so the live card stays current. */
export const LIVE_LIST_POLL_MS = 15_000;

let inFlight: Promise<void> | null = null;
let planView: PlannerJobView | null = null;
let synced = false;
/** Decided here; a poll that started before the decision must not bring them back. */
const decided = new Set<string>();
const signatures = new Map<string, string>();

/** True when `value` differs from what was applied under `key` last time. */
function changed(key: string, value: unknown): boolean {
    const sig = JSON.stringify(value);
    if (signatures.get(key) === sig) return false;
    signatures.set(key, sig);
    return true;
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

async function sync(): Promise<void> {
    let apiZone = useLive.getState().apiZone;
    if (!apiZone) {
        apiZone = (await getWatchZones()).find((z) => z.name === LIVE_ZONE_NAME) ?? null;
        if (!apiZone) throw new Error(`the api has no watch zone named ${LIVE_ZONE_NAME}`);
    }
    const id = apiZone.id;
    const [
        geography,
        serverRecords,
        detections,
        riskZones,
        incidents,
        responderList,
        assignments,
        approvals,
        jobs,
    ] = await Promise.all([
        getGeography(id),
        getEdgeServers(id),
        getDetections(id),
        getRiskZones(id),
        getIncidents(id),
        getResponders(id),
        getActiveAssignments(id),
        getPendingApprovals(id),
        getPlannerJobs(id),
    ]);
    const incident = openIncident(incidents);
    const jobId = planJobId(incident, jobs);
    // A plan is large and never changes once written, so it is fetched once per job.
    if (!jobId) planView = null;
    else if (planView?.job.jobId !== jobId) planView = await getPlannerJob(jobId);

    const zoneId = liveZoneId(id);
    let zone: WatchZone | undefined = useZones.getState().zones[zoneId];
    if (!zone || changed('boundary', apiZone.boundary)) {
        signatures.clear();
        changed('boundary', apiZone.boundary);
        const fresh = liveZone(apiZone, Date.now());
        zone = fresh;
        useZones.setState((s) => ({
            zones: { ...s.zones, [zoneId]: fresh },
            order: s.order.includes(zoneId) ? s.order : [zoneId, ...s.order],
        }));
    }

    const patch: Partial<WatchZone> = {};
    const servers = edgeServers(serverRecords);
    if (changed('servers', serverRecords)) patch.servers = servers;
    if (changed('geography', geography)) {
        patch.communities = communities(geography.civilianAreas);
        patch.safeZones = safeZones(geography.safeZones);
        patch.roads = roads(geography.roads);
    }
    const hazards = activeHazards(detections, riskZones, incidents);
    if (changed('risk', { hazards, servers: servers.map((s) => [s.lat, s.lon, s.radiusM]) })) {
        patch.risk = riskMap(zone.grid, hazards, servers);
        patch.riskVersion = zone.riskVersion + 1;
    }
    const result = planView?.result ?? null;
    if (changed('plan', { jobId: result?.jobId, geography, assignments })) {
        const plans = result ? livePlans(result, geography, assignments) : null;
        patch.civilianPlan = plans?.civilian ?? null;
        patch.responderPlan = plans?.responder ?? null;
    }
    if (changed('responders', responderList)) patch.responders = responders(responderList);
    if (Object.keys(patch).length > 0) useZones.getState().update(zoneId, patch);

    const alerts = pendingAlerts(approvals, geography.civilianAreas).filter(
        (a) => !decided.has(a.approval.id),
    );
    const plan = result
        ? {
              jobId: result.jobId,
              generatedAt: Date.parse(result.generatedAt),
              incidentId: planView?.job.incidentId ?? null,
          }
        : null;
    announce(useZones.getState().zones[zoneId] ?? zone, incident, plan, alerts);
    useLive.setState({
        status: 'online',
        error: null,
        apiZone,
        zoneId,
        lastSyncAt: Date.now(),
        incident,
        plan,
        alerts,
    });
    synced = true;
}

/** Toasts for what changed since the last poll; the first poll only sets the baseline. */
function announce(
    zone: WatchZone,
    incident: ReturnType<typeof openIncident>,
    plan: { jobId: string; incidentId: string | null } | null,
    alerts: LiveAlert[],
): void {
    if (!synced) return;
    const before = useLive.getState();
    if (incident && incident.id !== before.incident?.id) {
        notify('critical', `Incident #${incident.number} opened`, incident.title, zone);
    } else if (incident && before.incident && incident.state !== before.incident.state) {
        notify(
            'warning',
            `Incident #${incident.number} is ${incident.state}`,
            incident.title,
            zone,
        );
    } else if (!incident && before.incident) {
        notify('success', `Incident #${before.incident.number} closed`, '', zone);
    }
    if (plan && plan.jobId !== before.plan?.jobId) {
        notify('success', 'New plan ready', 'Suggestions show it on the map.', zone);
        const route = useRouter.getState().route;
        if (plan.incidentId && route.name === 'zone' && route.zoneId === zone.id)
            useUi.getState().setSuggestions(true);
    }
    const seen = new Set(before.alerts.map((a) => a.approval.id));
    const fresh = alerts.filter((a) => !seen.has(a.approval.id)).length;
    if (fresh > 0)
        notify(
            'warning',
            `${fresh} alert${fresh === 1 ? '' : 's'} awaiting approval`,
            'Civilian texts wait for your hold to approve.',
            zone,
        );
}

function fail(e: unknown): void {
    const lost = e instanceof LiveApiError && e.status === 404;
    useLive.setState((s) => ({
        status: 'error',
        error: message(e),
        // The zone may have been reseeded under a new id: look it up again next time.
        apiZone: lost ? null : s.apiZone,
    }));
}

/** One poll; overlapping calls share the poll in flight. */
export function syncLive(): Promise<void> {
    if (!__EMBER_LIVE__) {
        if (useLive.getState().status !== 'off') useLive.setState({ status: 'off' });
        return Promise.resolve();
    }
    inFlight ??= sync()
        .catch(fail)
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

/** Polls every `ms` while mounted; null pauses. */
export function useLivePolling(ms: number | null): void {
    useEffect(() => {
        if (ms === null) return;
        void syncLive();
        const timer = window.setInterval(() => void syncLive(), ms);
        return () => window.clearInterval(timer);
    }, [ms]);
}

function operator(): string {
    return useSession.getState().session?.email ?? 'operator';
}

function liveTarget(): { apiZoneId: string; zone: WatchZone | null } | null {
    const { apiZone, zoneId } = useLive.getState();
    if (!apiZone) return null;
    return { apiZoneId: apiZone.id, zone: (zoneId && useZones.getState().zones[zoneId]) || null };
}

/** A simulated fire at a point; Ember's operator-agent verifies it like a drone detection. */
export async function placeFire([lat, lon]: LatLon): Promise<void> {
    const target = liveTarget();
    if (!target) return;
    try {
        await postSimulatedDetection(target.apiZoneId, {
            center: { lat, lng: lon },
            radiusM: 150,
            risk: 'on_fire',
            confidence: 0.6,
            requestedBy: `dashboard:${operator()}`,
        });
        notify('info', 'Fire placed', 'Ember is verifying it.', target.zone);
    } catch (e) {
        notify('warning', 'Fire not placed', message(e), target.zone);
    }
    void syncLive();
}

export async function setRoadState(
    roadId: string,
    name: string | null,
    state: Exclude<RoadState, 'uncertain'>,
): Promise<void> {
    const target = liveTarget();
    if (!target) return;
    try {
        await postRoadObservation(target.apiZoneId, {
            roadId,
            state,
            source: 'operator',
            reportedBy: operator(),
            note: null,
            location: null,
        });
        notify(
            state === 'blocked' ? 'warning' : 'success',
            state === 'blocked' ? 'Road blocked' : 'Road reopened',
            `${name ?? 'The road'} is ${state}. Ember replans around it.`,
            target.zone,
        );
    } catch (e) {
        notify('warning', 'Road not updated', message(e), target.zone);
    }
    void syncLive();
}

/** Sends the operator's decision with the code shown on the draft. Resolves true when recorded. */
export async function decideAlert(
    alert: LiveAlert,
    decision: 'approve' | 'reject',
): Promise<boolean> {
    const target = liveTarget();
    const { approval } = alert;
    if (!target) return false;
    useLive.setState((s) => ({ deciding: [...s.deciding, approval.id] }));
    try {
        await postDecision(approval.id, {
            decision,
            operator: operator(),
            via: 'dashboard',
            confirmationCode: approval.confirmationCode,
        });
        decided.add(approval.id);
        useLive.setState((s) => ({
            alerts: s.alerts.filter((a) => a.approval.id !== approval.id),
        }));
        if (decision === 'approve')
            notify(
                'success',
                'Approved',
                `Texts to ${alert.areaName} are going out with a route map.`,
                target.zone,
            );
        else
            notify('info', 'Alert rejected', `Nothing was sent to ${alert.areaName}.`, target.zone);
        return true;
    } catch (e) {
        notify('warning', 'Decision not recorded', message(e), target.zone);
        return false;
    } finally {
        useLive.setState((s) => ({ deciding: s.deciding.filter((id) => id !== approval.id) }));
        void syncLive();
    }
}
