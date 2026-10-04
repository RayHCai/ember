import type {
    Blast,
    CreateBlastRequest,
    Scan,
    SuggestPlacementsResult,
    UpdateWatchZoneRequest,
    WatchZone,
} from '@ember/contracts';
import { api } from '../api';
import { message } from '../api/client';
import type { LatLon } from '../model/types';
import { latLng } from '../model/zone';
import { notify } from './notifications';
import { refresh } from './sync';
import { useZones } from './zones';

// Operator actions. Each calls the api, puts the answer in the store and reports failures.

export const DEFAULT_RADIUS_M = 500;

function zoneRef(zoneId: string): { id: string; name: string } | null {
    const zone = useZones.getState().records[zoneId]?.zone;
    return zone ? { id: zone.id, name: zone.name } : null;
}

function failed(title: string, err: unknown, zoneId?: string): null {
    notify('warning', title, message(err), zoneId ? zoneRef(zoneId) : null);
    return null;
}

/** The operator never names a zone: each takes the next free number. */
function nextZoneName(): string {
    const taken = new Set(useZones.getState().summaries?.map((z) => z.name));
    let n = taken.size + 1;
    while (taken.has(`Zone ${n}`)) n += 1;
    return `Zone ${n}`;
}

export async function createZone(boundary: LatLon[]): Promise<WatchZone | null> {
    try {
        const zone = await api.createZone({
            name: nextZoneName(),
            boundary: boundary.map(latLng),
        });
        useZones.setState((s) => ({
            summaries: s.summaries
                ? [{ ...zone, summary: emptySummary() }, ...s.summaries]
                : s.summaries,
        }));
        return zone;
    } catch (err) {
        return failed('Watch zone not created', err);
    }
}

function emptySummary() {
    return {
        edgeServers: 0,
        onlineEdgeServers: 0,
        placements: 0,
        drones: 0,
        coverage: 0,
        lastScan: null,
        riskZones: { onFire: 0, atRisk: 0, onFireM2: 0, atRiskM2: 0 },
        lastPlanAt: null,
    };
}

export async function updateZone(zoneId: string, body: UpdateWatchZoneRequest): Promise<boolean> {
    try {
        const zone = await api.updateZone(zoneId, body);
        useZones.getState().patch(zoneId, { zone });
        if (body.boundary) void refresh(zoneId, 'surroundings', 'placements');
        return true;
    } catch (err) {
        failed('Watch zone not saved', err, zoneId);
        return false;
    }
}

export async function suggestPlacements(
    zoneId: string,
    connectivityRadiusM: number,
): Promise<SuggestPlacementsResult | null> {
    try {
        const result = await api.suggestPlacements(zoneId, { connectivityRadiusM });
        useZones.getState().patch(zoneId, { placements: result.placements });
        return result;
    } catch (err) {
        return failed('No placements suggested', err, zoneId);
    }
}

/** Moves a placement on screen only; `savePlacement` stores where it ends up. */
export function dragPlacement(zoneId: string, placementId: string, at: LatLon): void {
    useZones.getState().patch(zoneId, (r) => ({
        placements: r.placements.map((p) =>
            p.placementId === placementId ? { ...p, location: latLng(at) } : p,
        ),
    }));
}

export async function savePlacement(zoneId: string, placementId: string): Promise<void> {
    const p = useZones
        .getState()
        .records[zoneId]?.placements.find((x) => x.placementId === placementId);
    if (!p) return;
    try {
        const saved = await api.updatePlacement(placementId, { location: p.location });
        useZones.getState().patch(zoneId, (r) => ({
            placements: r.placements.map((x) => (x.placementId === placementId ? saved : x)),
        }));
    } catch (err) {
        failed('Site not moved', err, zoneId);
        void refresh(zoneId, 'placements');
    }
}

export async function removePlacement(zoneId: string, placementId: string): Promise<void> {
    try {
        await api.deletePlacement(placementId);
        useZones.getState().patch(zoneId, (r) => ({
            placements: r.placements.filter((p) => p.placementId !== placementId),
        }));
    } catch (err) {
        failed('Site not removed', err, zoneId);
    }
}

/** A registered connector takes over a planned site and becomes one of the zone's edge servers. */
export async function assignPlacement(
    zoneId: string,
    placementId: string,
    edgeServerId: string,
): Promise<boolean> {
    try {
        const server = await api.assignPlacement(placementId, edgeServerId);
        useZones.getState().patch(zoneId, (r) => ({
            placements: r.placements.filter((p) => p.placementId !== placementId),
            edgeServers: [...r.edgeServers.filter((e) => e.edgeServerId !== edgeServerId), server],
        }));
        useZones.setState((s) => ({
            unassigned: s.unassigned.filter((e) => e.edgeServerId !== edgeServerId),
        }));
        notify('success', 'Edge server connected', '', zoneRef(zoneId));
        void refresh(zoneId, 'edgeServers', 'drones');
        return true;
    } catch (err) {
        failed('Edge server not assigned', err, zoneId);
        return false;
    }
}

export async function releaseServer(zoneId: string, edgeServerId: string): Promise<void> {
    try {
        await api.updateEdgeServer(edgeServerId, { zoneId: null });
        useZones.getState().patch(zoneId, (r) => ({
            edgeServers: r.edgeServers.filter((e) => e.edgeServerId !== edgeServerId),
        }));
        void refresh(zoneId, 'drones');
    } catch (err) {
        failed('Edge server not removed', err, zoneId);
    }
}

function putScan(zoneId: string, scan: Scan): void {
    useZones.getState().patch(zoneId, (r) => ({
        scans: [scan, ...r.scans.filter((s) => s.runId !== scan.runId)],
    }));
}

export async function startScan(zoneId: string): Promise<Scan | null> {
    try {
        const scan = await api.startScan(zoneId);
        putScan(zoneId, scan);
        const zone = zoneRef(zoneId);
        if (scan.state === 'failed') notify('critical', 'Scan failed', scan.error ?? '', zone);
        else {
            const flying = scan.results.flatMap((r) => (r.ok ? r.drones : [])).length;
            notify(
                'info',
                'Scan started',
                `${flying} drone${flying === 1 ? '' : 's'} launched over ${zone?.name ?? 'the zone'}.`,
                zone,
            );
            if (scan.error)
                notify('warning', 'Some edge servers refused the scan', scan.error, zone);
        }
        void refresh(zoneId, 'runs', 'riskZones');
        return scan;
    } catch (err) {
        return failed('Scan not started', err, zoneId);
    }
}

export async function stopScan(zoneId: string, runId: string): Promise<void> {
    try {
        putScan(zoneId, await api.stopScan(zoneId, runId));
        notify(
            'warning',
            'Scan stopped',
            'Drones are flying back to their edge servers.',
            zoneRef(zoneId),
        );
    } catch (err) {
        failed('Scan not stopped', err, zoneId);
    }
}

export async function runPlanner(zoneId: string): Promise<boolean> {
    try {
        const job = await api.createPlannerJob(zoneId, {});
        useZones.getState().patch(zoneId, (r) => ({ planJobs: [job, ...r.planJobs] }));
        return true;
    } catch (err) {
        failed('Planner not started', err, zoneId);
        return false;
    }
}

function putBlast(zoneId: string, blast: Blast): void {
    useZones.getState().patch(zoneId, (r) => ({
        blasts: [blast, ...r.blasts.filter((b) => b.blastId !== blast.blastId)],
    }));
}

/** Civilian blasts are approved only by `approve: true` from this signed-in operator. */
export async function createBlast(zoneId: string, body: CreateBlastRequest): Promise<Blast | null> {
    try {
        const blast = await api.createBlast(zoneId, body);
        putBlast(zoneId, blast);
        return blast;
    } catch (err) {
        return failed('Blast not sent', err, zoneId);
    }
}

export async function approveBlast(zoneId: string, blastId: string): Promise<Blast | null> {
    try {
        const blast = await api.approveBlast(blastId);
        putBlast(zoneId, blast);
        return blast;
    } catch (err) {
        return failed('Blast not approved', err, zoneId);
    }
}
