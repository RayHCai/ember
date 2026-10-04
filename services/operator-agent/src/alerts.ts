import type {
    AttackZone,
    CivilianImpact,
    CreateBlastRequest,
    EvacuationRoute,
    LatLng,
    PlannerResult,
    WatchZone,
    ZoneSurroundings,
} from '@ember/contracts';
import { compass, roadNamesAlong } from './geo.js';

/** The api's blast limits. */
const TITLE_MAX = 120;
const BODY_MAX = 1000;

export const DISCLAIMER = 'Ember forecast, not an official order: follow emergency officials.';
const RESPONDER_PREFIX = 'Responder staging: ';
const EVACUATION_TITLE = /^Evacuation ZIP (\d{5})\b/;

export const isResponderBrief = (title: string) => title.startsWith(RESPONDER_PREFIX);

/** The ZIP an evacuation blast is for, read back from its title; null for any other blast. */
export const zipOfBlast = (title: string) => EVACUATION_TITLE.exec(title)?.[1] ?? null;

const EVACUATE = new Set<CivilianImpact['severity']>(['immediate', 'warning']);

export type AreaEvacuation = {
    impact: CivilianImpact;
    route: EvacuationRoute | null;
};

/** One evacuation text: every area to leave in one ZIP, soonest fire first. */
export type ZipEvacuation = { zipCode: string; areas: AreaEvacuation[] };

/**
 * The areas the plan says must leave now (`immediate` or `warning`), grouped by the ZIP each
 * area's centre lies in. Areas whose ZIP is unknown are left out and returned for the log.
 */
export function evacuationsByZip(
    result: PlannerResult,
    zipOfArea: Map<string, string | null>,
): { byZip: ZipEvacuation[]; unplaced: CivilianImpact[] } {
    const byZip = new Map<string, AreaEvacuation[]>();
    const unplaced: CivilianImpact[] = [];
    for (const impact of result.civilianImpacts) {
        if (!EVACUATE.has(impact.severity)) continue;
        const zip = zipOfArea.get(impact.civilianAreaId) ?? null;
        if (!zip) {
            unplaced.push(impact);
            continue;
        }
        const route =
            result.evacuationRoutes.find((r) => r.civilianAreaId === impact.civilianAreaId) ?? null;
        byZip.set(zip, [...(byZip.get(zip) ?? []), { impact, route }]);
    }
    const soonest = (a: AreaEvacuation) => a.impact.impactMin ?? Infinity;
    return {
        byZip: [...byZip]
            .map(([zipCode, areas]) => ({
                zipCode,
                areas: areas.toSorted((a, b) => soonest(a) - soonest(b)),
            }))
            .toSorted((a, b) => soonest(a.areas[0]!) - soonest(b.areas[0]!)),
        unplaced,
    };
}

const minutes = (m: number) => `about ${Math.max(1, Math.round(m))} min`;
const point = (p: LatLng) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

function arrival(impact: CivilianImpact) {
    if (impact.impactMin === null) return `Fire threatens ${impact.name}.`;
    if (impact.impactMin <= 0) return `Fire has reached ${impact.name}.`;
    return `Fire is forecast to reach ${impact.name} in ${minutes(impact.impactMin)}.`;
}

function routeLine(a: AreaEvacuation, s: ZoneSurroundings) {
    const { route, impact } = a;
    if (!route || route.status === 'no_safe_route' || !route.path.length) {
        return `${impact.name}: no safe road out was found. If you cannot leave safely, call 911.`;
    }
    const via = roadNamesAlong(route.path, s.roads);
    const safe = route.destination?.safeZoneId
        ? s.safeZones.find((z) => z.id === route.destination!.safeZoneId)
        : undefined;
    const to = safe?.name ?? (route.destination ? point(route.destination.location) : 'safety');
    const road = via.length ? `take ${via.join(', then ')}` : 'take the nearest main road';
    const tight = route.status === 'tight' ? ' Leave right away: the margin is small.' : '';
    return `${impact.name}: ${road} to ${to} (${minutes(route.etaMin)}).${tight}`;
}

/** Joins lines in order, dropping optional ones that would push past the limit. */
function fit(required: string[], optional: string[], tail: string[], max: number) {
    const fixed = [...required, ...tail].join('\n').length;
    let room = max - fixed;
    const kept: string[] = [];
    for (const line of optional) {
        if (line.length + 1 > room) break;
        kept.push(line);
        room -= line.length + 1;
    }
    return [...required, ...kept, ...tail].join('\n').slice(0, max);
}

/** An evacuation blast for one ZIP; it waits for an operator's approval at the api. */
export function evacuationBlast(
    zone: WatchZone,
    e: ZipEvacuation,
    s: ZoneSurroundings,
    mapUrl: string | null,
): CreateBlastRequest {
    const lead = e.areas[0]!;
    const names = e.areas.map((a) => a.impact.name).join(', ');
    const lines = e.areas.map((a) => routeLine(a, s));
    const map = mapUrl ? [`Map: ${mapUrl}?${new URLSearchParams({ zone: zone.id })}`] : [];
    return {
        audience: 'civilians',
        priority: e.areas.some((a) => a.impact.severity === 'immediate') ? 'critical' : 'urgent',
        area: 'near_fire',
        title: `Evacuation ZIP ${e.zipCode}: ${names}`.slice(0, TITLE_MAX),
        body: fit(
            [
                `EMBER WILDFIRE ALERT, ZIP ${e.zipCode}. ${arrival(lead.impact)} Evacuate now.`,
                lines[0]!,
            ],
            lines.slice(1),
            [...map, DISCLAIMER],
            BODY_MAX,
        ),
    };
}

function stagingLine(z: AttackZone) {
    const access = z.accessMin === null ? '' : `, ${minutes(z.accessMin)} from the nearest station`;
    const protects = z.protects.length
        ? ` Protects ${z.protects.slice(0, 3).join(', ')} (${z.protectedPopulation.toLocaleString('en-US')} people).`
        : '';
    return (
        `#${z.rank} ${z.tactic} attack: stage at ${point(z.dropSite)}${access}; work a ${Math.round(z.radiusM)} m radius. ` +
        `Fire arrives in ${minutes(z.fireArrivalMin)}.${protects}`
    );
}

/** Where responders should stage, from the plan's ranked attack zones. Responder blasts need no approval. */
export function responderBlast(
    zone: WatchZone,
    result: PlannerResult,
    count: number,
): CreateBlastRequest {
    const zones = [...result.attackZones].toSorted((a, b) => a.rank - b.rank).slice(0, count);
    const spread = result.fireSpread;
    const heading =
        spread.headingDeg === null
            ? 'Fire is not moving'
            : `Fire heading ${compass(spread.headingDeg)}`;
    const lines = zones.map(stagingLine);
    return {
        audience: 'responders',
        priority: 'urgent',
        area: 'near_fire',
        title: `${RESPONDER_PREFIX}${zone.name}`.slice(0, TITLE_MAX),
        body: fit(
            [
                `${heading}, spreading up to ${spread.maxSpreadMpm.toFixed(1)} m/min.`,
                lines[0] ??
                    'The plan found no attack zone; hold at stations and protect evacuation routes.',
            ],
            lines.slice(1),
            [],
            BODY_MAX,
        ),
    };
}
