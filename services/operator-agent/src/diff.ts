import type { PlannerResult } from '@ember/contracts';
import { attackZoneLabel, roadNames, type Geography } from './views.js';

export type AreaChange = 'severity' | 'arrival' | 'route' | 'destination' | 'status' | 'alternate';

export type AttackZoneChange = {
    id: string;
    label: string;
    change: 'added' | 'removed' | 'moved' | 'rerouted' | 'unchanged';
    detail: string;
};

export type AreaDiff = {
    civilianAreaId: string;
    area: string;
    changes: AreaChange[];
    detail: string[];
};

export type PlanDiff = {
    oldJobId: string;
    newJobId: string;
    attackZones: AttackZoneChange[];
    /** Only areas whose impact or route changed. */
    civilianAreas: AreaDiff[];
};

/** Arrival shifts smaller than this are forecast noise, not news for a civilian. */
const ARRIVAL_CHANGE_MIN = 5;
const DROP_SITE_MOVE_M = 50;

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const rad = Math.PI / 180;
    const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    const y = (b.lat - a.lat) * rad;
    return Math.hypot(x, y) * 6_371_008.8;
}

const join = (ids: string[] | undefined) => (ids ?? []).join('>');

/** What changed between two plans of the same zone, as the people on the ground would see it. */
export function diffPlans(older: PlannerResult, newer: PlannerResult, geo: Geography): PlanDiff {
    const names = (ids: string[]) => roadNames(geo.roads, ids).join(', ') || 'no roads';
    const attackZones: AttackZoneChange[] = [];
    for (const z of newer.attackZones) {
        const old = older.attackZones.find((o) => o.id === z.id);
        const label = attackZoneLabel(z.rank);
        if (!old) {
            attackZones.push({ id: z.id, label, change: 'added', detail: 'new attack zone' });
        } else if (metres(old.dropSite, z.dropSite) > DROP_SITE_MOVE_M) {
            attackZones.push({
                id: z.id,
                label,
                change: 'moved',
                detail: `drop site moved ${Math.round(metres(old.dropSite, z.dropSite))} m`,
            });
        } else if (join(old.approach?.roadIds) !== join(z.approach?.roadIds)) {
            attackZones.push({
                id: z.id,
                label,
                change: 'rerouted',
                detail: `approach via ${names(z.approach?.roadIds ?? [])} instead of ${names(old.approach?.roadIds ?? [])}`,
            });
        } else {
            attackZones.push({ id: z.id, label, change: 'unchanged', detail: '' });
        }
    }
    for (const old of older.attackZones) {
        if (!newer.attackZones.some((z) => z.id === old.id)) {
            attackZones.push({
                id: old.id,
                label: attackZoneLabel(old.rank),
                change: 'removed',
                detail: 'no longer recommended',
            });
        }
    }

    const civilianAreas: AreaDiff[] = [];
    const ids = new Set([
        ...older.civilianImpacts.map((i) => i.civilianAreaId),
        ...newer.civilianImpacts.map((i) => i.civilianAreaId),
    ]);
    for (const id of ids) {
        const a = older.civilianImpacts.find((i) => i.civilianAreaId === id);
        const b = newer.civilianImpacts.find((i) => i.civilianAreaId === id);
        const ra = older.evacuationRoutes.find((r) => r.civilianAreaId === id);
        const rb = newer.evacuationRoutes.find((r) => r.civilianAreaId === id);
        const changes: AreaChange[] = [];
        const detail: string[] = [];
        if (a?.severity !== b?.severity) {
            changes.push('severity');
            detail.push(`severity ${a?.severity ?? 'none'} → ${b?.severity ?? 'none'}`);
        }
        const ta = a?.impactMin ?? null;
        const tb = b?.impactMin ?? null;
        if (
            (ta === null) !== (tb === null) ||
            (ta !== null && tb !== null && Math.abs(ta - tb) >= ARRIVAL_CHANGE_MIN)
        ) {
            changes.push('arrival');
            detail.push(
                `fire arrival ${ta === null ? 'none' : `${Math.round(ta)} min`} → ${tb === null ? 'none' : `${Math.round(tb)} min`}`,
            );
        }
        if (ra?.status !== rb?.status) {
            changes.push('status');
            detail.push(`route ${ra?.status ?? 'none'} → ${rb?.status ?? 'none'}`);
        }
        if (join(ra?.roadIds) !== join(rb?.roadIds)) {
            changes.push('route');
            detail.push(`now via ${names(rb?.roadIds ?? [])} (was ${names(ra?.roadIds ?? [])})`);
        }
        if (ra?.destination?.safeZoneId !== rb?.destination?.safeZoneId) {
            changes.push('destination');
            const zone = (sid: string | null | undefined) =>
                geo.safeZones.find((z) => z.id === sid)?.name ?? (sid ? sid : 'none');
            detail.push(
                `destination ${zone(ra?.destination?.safeZoneId)} → ${zone(rb?.destination?.safeZoneId)}`,
            );
        }
        if (join(ra?.alternate?.roadIds) !== join(rb?.alternate?.roadIds)) {
            changes.push('alternate');
            detail.push(`alternate now via ${names(rb?.alternate?.roadIds ?? [])}`);
        }
        if (changes.length) {
            civilianAreas.push({
                civilianAreaId: id,
                area: b?.name ?? a?.name ?? id,
                changes,
                detail,
            });
        }
    }
    return { oldJobId: older.jobId, newJobId: newer.jobId, attackZones, civilianAreas };
}
