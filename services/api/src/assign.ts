import type {
    AttackZone,
    CivilianArea,
    Incident,
    PlannerResult,
    Responder,
    ResponderAssignment,
    Road,
    WatchZoneId,
} from '@ember/contracts';
import { compass, distanceM } from './geo.js';

/** A drop site that moved less than this is the same place for a crew already on its way. */
const SAME_DROP_SITE_M = 50;

export const attackZoneLabel = (rank: number) =>
    rank <= 26 ? String.fromCharCode(64 + rank) : `${rank}`;

export function instructions(
    zone: AttackZone,
    incident: Incident | null,
    roads: Road[],
    areas: CivilianArea[],
): string {
    const parts: string[] = [];
    if (incident) parts.push(`Incident #${incident.number}.`);
    const roadId = zone.approach?.roadIds.at(-1);
    const road = roads.find((r) => r.id === roadId);
    const drop = road?.name
        ? `drop site on ${road.name}`
        : `drop site at ${zone.dropSite.lat.toFixed(5)}, ${zone.dropSite.lng.toFixed(5)}`;
    parts.push(`Deploy to Attack Zone ${attackZoneLabel(zone.rank)} (${drop}).`);
    if (zone.approach?.arrivesFromDeg != null) {
        parts.push(`Approach from the ${compass(zone.approach.arrivesFromDeg)}.`);
    }
    parts.push(`Projected fire arrival ≈ ${Math.round(zone.fireArrivalMin)} min.`);
    parts.push(
        zone.tactic === 'direct'
            ? 'Direct attack on the fire edge.'
            : 'Indirect attack: cut line ahead of the front.',
    );
    const protects = zone.protects
        .map((id) => areas.find((a) => a.id === id)?.name)
        .filter((n): n is string => !!n);
    if (protects.length) parts.push(`Protects ${protects.join(', ')}.`);
    return parts.join(' ');
}

function unchanged(old: AttackZone | undefined, next: AttackZone | undefined): boolean {
    if (!old || !next) return false;
    if (distanceM(old.dropSite, next.dropSite) > SAME_DROP_SITE_M) return false;
    return (old.approach?.roadIds ?? []).join() === (next.approach?.roadIds ?? []).join();
}

export type AssignInput = {
    zoneId: WatchZoneId;
    jobId: string;
    result: PlannerResult;
    /** The plans the active assignments were made from, by job id. */
    previous: Map<string, PlannerResult>;
    responders: Responder[];
    active: ResponderAssignment[];
    roads: Road[];
    areas: CivilianArea[];
    incident: Incident | null;
    attackZoneIds: string[] | undefined;
    perZone: number;
    now: string;
};

export type AssignOutput = {
    kept: ResponderAssignment[];
    created: ResponderAssignment[];
    superseded: ResponderAssignment[];
    unassigned: string[];
};

/**
 * Rank order, one pass: keep crews whose zone is unchanged, supersede the rest, then fill each
 * zone from available responders, preferring the station its approach starts from.
 */
export function assign(input: AssignInput): AssignOutput {
    const zones = input.result.attackZones
        .filter((z) => !input.attackZoneIds || input.attackZoneIds.includes(z.id))
        .toSorted((a, b) => a.rank - b.rank);
    const byId = new Map(zones.map((z) => [z.id, z]));
    const kept: ResponderAssignment[] = [];
    const superseded: ResponderAssignment[] = [];
    for (const a of input.active) {
        const old = input.previous.get(a.jobId)?.attackZones.find((z) => z.id === a.attackZoneId);
        const next = byId.get(a.attackZoneId);
        if (a.jobId === input.jobId && !next) {
            kept.push(a);
        } else if (a.jobId === input.jobId || unchanged(old, next)) {
            kept.push({
                ...a,
                jobId: input.jobId,
                instructions: instructions(next!, input.incident, input.roads, input.areas),
                updatedAt: input.now,
            });
        } else {
            superseded.push({ ...a, state: 'superseded', updatedAt: input.now });
        }
    }

    const busy = new Set(kept.map((a) => a.responderId));
    const freed = new Set(superseded.map((a) => a.responderId));
    const pool = input.responders
        .filter(
            (r) =>
                !busy.has(r.id) &&
                r.status !== 'off_duty' &&
                (r.availability === 'available' || freed.has(r.id)),
        )
        .toSorted((a, b) => a.number - b.number);

    const created: ResponderAssignment[] = [];
    const unassigned: string[] = [];
    for (const zone of zones) {
        let need = input.perZone - kept.filter((a) => a.attackZoneId === zone.id).length;
        const station = zone.approach?.stationId;
        while (need > 0) {
            const i = Math.max(
                pool.findIndex((r) => station && r.stationId === station),
                pool.length ? 0 : -1,
            );
            const pick = i >= 0 ? pool.splice(i, 1)[0] : undefined;
            if (!pick) break;
            created.push({
                id: crypto.randomUUID(),
                responderId: pick.id,
                zoneId: input.zoneId,
                incidentId: input.incident?.id ?? null,
                jobId: input.jobId,
                attackZoneId: zone.id,
                attackZoneLabel: attackZoneLabel(zone.rank),
                dropSite: zone.dropSite,
                instructions: instructions(zone, input.incident, input.roads, input.areas),
                state: 'active',
                createdAt: input.now,
                updatedAt: input.now,
            });
            need -= 1;
        }
        if (need === input.perZone) unassigned.push(zone.id);
    }
    return { kept, created, superseded, unassigned };
}
