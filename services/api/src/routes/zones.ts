import type { FastifyInstance } from 'fastify';
import {
    WATCH_ZONE_PATH,
    WATCH_ZONES_PATH,
    ZONE_GEOGRAPHY_PATH,
    RISK_ZONE_PATH,
    ZONE_RISK_ZONES_PATH,
    ZONE_ROAD_OBSERVATIONS_PATH,
    ZONE_ROADS_PATH,
    ZONE_SURVEILLANCE_PATH,
    ZONE_WEATHER_PATH,
    type Road,
    type RoadObservation,
    type RiskZoneRecord,
    type WatchZone,
    type WatchZoneId,
    type ZoneWeather,
} from '@ember/contracts';
import { guard, STAFF } from '../auth.js';
import { geographyOf, iso, requireZone, type Deps } from '../deps.js';
import { HttpError, parse } from '../errors.js';
import { areaHa, centroid, circle } from '../geo.js';
import * as s from '../schemas.js';

type ZoneParams = { Params: { zoneId: string } };

const ABBREVIATIONS: Record<string, string> = {
    road: 'rd',
    street: 'st',
    highway: 'hwy',
    avenue: 'ave',
    drive: 'dr',
    lane: 'ln',
    boulevard: 'blvd',
    place: 'pl',
};

export function normalizeRoadName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => ABBREVIATIONS[w] ?? w)
        .join(' ');
}

/** Roads named `query`: exact normalised name first, then names containing it (or it them). */
export function matchRoads(roads: Road[], query: string): Road[] {
    const q = normalizeRoadName(query);
    const named = roads.filter((r) => r.name);
    const exact = named.filter((r) => normalizeRoadName(r.name!) === q);
    if (exact.length) return exact;
    return named.filter((r) => {
        const n = normalizeRoadName(r.name!);
        return n.includes(q) || q.includes(n);
    });
}

const candidates = (roads: Road[]) => roads.map((r) => ({ id: r.id, name: r.name }));

export function zoneRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    app.get(WATCH_ZONES_PATH, staff, async () => store.zones.list({}, { orderBy: 'createdAt' }));

    app.post(WATCH_ZONES_PATH, staff, async (req, reply) => {
        const body = parse(s.createWatchZone, req.body);
        const boundary = body.boundary ?? circle(body.center!, body.radiusM!);
        const now = iso(deps.now());
        const zone: WatchZone = {
            id: crypto.randomUUID() as WatchZoneId,
            name: body.name,
            boundary,
            center: centroid(boundary),
            areaHa: Math.round(areaHa(boundary) * 10) / 10,
            surveillance: null,
            createdAt: now,
            updatedAt: now,
        };
        await store.zones.insert(zone);
        return reply.code(201).send(zone);
    });

    app.get<ZoneParams>(WATCH_ZONE_PATH, staff, async (req) =>
        requireZone(store, req.params.zoneId),
    );

    app.get<ZoneParams>(ZONE_GEOGRAPHY_PATH, staff, async (req) => {
        const { zoneId: _, ...geo } = await geographyOf(
            store,
            await requireZone(store, req.params.zoneId),
        );
        return geo;
    });

    app.put<ZoneParams>(ZONE_GEOGRAPHY_PATH, staff, async (req) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.geography, req.body);
        const previous = await geographyOf(store, zone);
        const kept = new Map(previous.roads.map((r) => [r.id, r.state]));
        const stored = {
            ...body,
            zoneId: zone.id,
            roads: body.roads.map((r): Road => ({
                id: r.id,
                name: r.name,
                kind: r.kind,
                path: r.path,
                state: r.state ?? kept.get(r.id) ?? 'open',
            })),
        };
        await store.geography.put(stored);
        const { zoneId: _, ...geo } = stored;
        return geo;
    });

    app.get<ZoneParams>(ZONE_WEATHER_PATH, staff, async (req) => {
        const zone = await requireZone(store, req.params.zoneId);
        const out: ZoneWeather = {
            zoneId: zone.id,
            weather: await deps.weather.current(zone.center),
            fetchedAt: iso(deps.now()),
        };
        return out;
    });

    app.get<ZoneParams>(ZONE_SURVEILLANCE_PATH, staff, async (req) => {
        return (await requireZone(store, req.params.zoneId)).surveillance;
    });

    app.put<ZoneParams>(ZONE_SURVEILLANCE_PATH, staff, async (req) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.surveillance, req.body);
        const now = iso(deps.now());
        zone.surveillance = { ...body, setAt: now };
        zone.updatedAt = now;
        await store.zones.put(zone);
        return zone.surveillance;
    });

    app.get<ZoneParams>(ZONE_ROADS_PATH, staff, async (req) => {
        return (await geographyOf(store, await requireZone(store, req.params.zoneId))).roads;
    });

    app.get<ZoneParams>(ZONE_ROAD_OBSERVATIONS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        return store.roadObservations.list(
            { zoneId: req.params.zoneId as WatchZoneId },
            { orderBy: 'observedAt', desc: true },
        );
    });

    app.post<ZoneParams>(ZONE_ROAD_OBSERVATIONS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.roadObservation, req.body);
        const geo = await geographyOf(store, zone);
        let targets: Road[];
        if (body.roadId) {
            targets = geo.roads.filter((r) => r.id === body.roadId);
            if (!targets.length) {
                throw new HttpError(404, `road ${body.roadId} not in zone ${zone.id}`, {
                    candidates: candidates(geo.roads),
                });
            }
        } else {
            targets = matchRoads(geo.roads, body.roadName!);
            const names = new Set(targets.map((r) => normalizeRoadName(r.name!)));
            if (!targets.length) {
                throw new HttpError(404, `no road named "${body.roadName}" in zone ${zone.id}`, {
                    candidates: candidates(geo.roads.filter((r) => r.name)),
                });
            }
            if (names.size > 1) {
                throw new HttpError(409, `"${body.roadName}" matches several roads`, {
                    candidates: candidates(targets),
                });
            }
        }
        const observedAt = iso(deps.now());
        const observations: RoadObservation[] = targets.map((road) => ({
            id: crypto.randomUUID(),
            zoneId: zone.id,
            roadId: road.id,
            roadName: road.name,
            state: body.state,
            previousState: road.state,
            source: body.source,
            reportedBy: body.reportedBy,
            note: body.note,
            location: body.location,
            observedAt,
        }));
        const ids = new Set(targets.map((r) => r.id));
        geo.roads = geo.roads.map((r) => (ids.has(r.id) ? { ...r, state: body.state } : r));
        await store.geography.put(geo);
        for (const o of observations) await store.roadObservations.insert(o);
        return reply.code(201).send(observations);
    });

    app.get<ZoneParams>(ZONE_RISK_ZONES_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        return store.riskZones.list(
            { zoneId: req.params.zoneId as WatchZoneId },
            { orderBy: 'observedAt', desc: true },
        );
    });

    app.delete<{ Params: { zoneId: string; riskZoneId: string } }>(
        RISK_ZONE_PATH,
        staff,
        async (req, reply) => {
            const record = await store.riskZones.get(req.params.riskZoneId);
            if (!record || record.zoneId !== req.params.zoneId) {
                throw new HttpError(
                    404,
                    `risk zone ${req.params.riskZoneId} not in zone ${req.params.zoneId}`,
                );
            }
            await store.riskZones.remove(record.id);
            return reply.code(204).send();
        },
    );

    app.post<ZoneParams>(ZONE_RISK_ZONES_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.createRiskZone, req.body);
        const record: RiskZoneRecord = {
            id: crypto.randomUUID(),
            zoneId: zone.id,
            source: 'operator',
            detectionIds: [],
            ...body,
        };
        await store.riskZones.insert(record);
        return reply.code(201).send(record);
    });
}
