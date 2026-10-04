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
export const point = (p: LatLng) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

/** Lead over the fire kept when telling people the latest time to leave. */
const LEAVE_MARGIN_MIN = 10;

/** "25 min", "1 hr 20 min", "2 hr". */
export function duration(min: number) {
    const m = Math.max(1, Math.round(min));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

/** "3:40 pm HST": the wall clock where the alert is read. */
export function clock(at: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === type)?.value ?? '';
    return `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()} ${part('timeZoneName')}`;
}

export const usable = (r: EvacuationRoute | null) =>
    r && r.status !== 'no_safe_route' && r.path.length > 1 ? r : null;

/** The area the fire reaches first and its route out; undefined when none is in its path. */
export function leadEvacuation(result: PlannerResult): AreaEvacuation | undefined {
    return result.civilianImpacts
        .filter((i) => i.severity !== 'clear')
        .toSorted((a, b) => (a.impactMin ?? Infinity) - (b.impactMin ?? Infinity))
        .map((impact) => ({
            impact,
            route:
                result.evacuationRoutes.find((r) => r.civilianAreaId === impact.civilianAreaId) ??
                null,
        }))[0];
}

/**
 * When fire reaches the area, and the latest time to leave: before the fire reaches the area or
 * cuts its route (the route's clearance), less a margin. Null when the plan has no arrival.
 */
export function timing(a: AreaEvacuation, generatedAt: string) {
    const { impactMin } = a.impact;
    if (impactMin === null) return null;
    const t0 = Date.parse(generatedAt);
    const lead = Math.min(impactMin, usable(a.route)?.clearanceMin ?? impactMin);
    return {
        reachAt: new Date(t0 + impactMin * 60_000),
        leaveBy: new Date(t0 + Math.max(0, lead - LEAVE_MARGIN_MIN) * 60_000),
    };
}

/** "via Honoapiilani Hwy to Kapalua Airport"; null without a safe route. */
export function wayOut(a: AreaEvacuation, s: ZoneSurroundings) {
    const route = usable(a.route);
    if (!route) return null;
    const via = roadNamesAlong(route.path, s.roads);
    const safe = route.destination?.safeZoneId
        ? s.safeZones.find((z) => z.id === route.destination!.safeZoneId)
        : undefined;
    const to = safe?.name ?? (route.destination ? point(route.destination.location) : 'safety');
    return `${via.length ? `via ${via.join(', then ')} ` : ''}to ${to}`;
}

const NO_ROUTE = 'No safe road out was found; if you cannot leave safely, call 911.';

/** "Evacuate by 3:40 pm HST via Honoapiilani Hwy to Kapalua Airport." */
function evacuate(
    a: AreaEvacuation,
    s: ZoneSurroundings,
    generatedAt: string,
    now: Date,
    tz: string,
) {
    const leaveBy = timing(a, generatedAt)?.leaveBy;
    const when =
        leaveBy && leaveBy.getTime() - now.getTime() > 60_000 ? `by ${clock(leaveBy, tz)}` : 'now';
    const way = wayOut(a, s);
    return way ? `Evacuate ${when} ${way}.` : `Evacuate ${when}. ${NO_ROUTE}`;
}

/**
 * The alert for someone in one area: "Ember Alert: Evacuate by 3:40 pm HST via ... to ...", or
 * "Ember Alert: Another way out. Evacuate ..." for a route planned around one reported blocked.
 */
export function areaAlert(
    a: AreaEvacuation,
    s: ZoneSurroundings,
    generatedAt: string,
    now: Date,
    tz: string,
    alternate = false,
) {
    return `Ember Alert: ${alternate ? 'Another way out. ' : ''}${evacuate(a, s, generatedAt, now, tz)}`;
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

/**
 * An evacuation blast for one ZIP; it waits for an operator's approval at the api, so its times
 * are clock times, still right whenever it is sent.
 */
export function evacuationBlast(
    zone: WatchZone,
    e: ZipEvacuation,
    s: ZoneSurroundings,
    plan: { generatedAt: string; now: Date; timeZone: string; mapUrl: string | null },
): CreateBlastRequest {
    const { generatedAt, now, timeZone: tz, mapUrl } = plan;
    const line = (a: AreaEvacuation, lead: boolean) =>
        `${lead ? 'Ember Alert' : a.impact.name}: ${evacuate(a, s, generatedAt, now, tz)}`;
    const names = e.areas.map((a) => a.impact.name).join(', ');
    const map = mapUrl ? [`Map: ${mapUrl}?${new URLSearchParams({ zone: zone.id })}`] : [];
    return {
        audience: 'civilians',
        priority: e.areas.some((a) => a.impact.severity === 'immediate') ? 'critical' : 'urgent',
        area: 'near_fire',
        title: `Evacuation ZIP ${e.zipCode}: ${names}`.slice(0, TITLE_MAX),
        body: fit(
            [line(e.areas[0]!, true)],
            e.areas.slice(1).map((a) => line(a, false)),
            map,
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
