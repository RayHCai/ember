import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
    RESPONDER_BUNDLE_PATH,
    RESPONDER_PAIR_PATH,
    RESPONDER_PAIRING_CODES_PATH,
    RESPONDER_PAIRING_KIND,
    RESPONDER_PATH,
    ZONE_ASSIGNMENTS_PATH,
    ZONE_RESPONDER_MESSAGES_PATH,
    ZONE_RESPONDERS_PATH,
    type AssignRespondersResult,
    type PlannerResult,
    type Responder,
    type ResponderMessage,
    type ResponderPairingCode,
    type ResponderPlan,
    type ResponderSession,
    type ResponderZoneBundle,
    type WatchZoneId,
} from '@ember/contracts';
import { z } from 'zod';
import { assign } from '../assign.js';
import { guard, STAFF } from '../auth.js';
import { geographyOf, iso, requireZone, type Deps } from '../deps.js';
import { HttpError, notFound, parse } from '../errors.js';
import * as s from '../schemas.js';
import { plannerContext } from './planner.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const BUNDLE_MESSAGES = 50;

const assignmentQuery = z.object({
    state: z.enum(['active', 'superseded', 'completed', 'cancelled']).optional(),
    responderId: z.string().optional(),
    incidentId: z.string().optional(),
});

const messageQuery = z.object({ responderId: z.string().optional() });

const token = () => randomBytes(24).toString('base64url');

export function responderRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    app.get<{ Params: { zoneId: string } }>(ZONE_RESPONDERS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        return store.responders.list(
            { zoneId: req.params.zoneId as WatchZoneId },
            { orderBy: 'number' },
        );
    });

    app.post<{ Params: { zoneId: string } }>(ZONE_RESPONDERS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.createResponder, req.body);
        const responder: Responder = {
            id: crypto.randomUUID(),
            number: await store.counters.next('responder'),
            zoneId: zone.id,
            ...body,
            availability: 'available',
            status: 'idle',
            updatedAt: iso(deps.now()),
        };
        await store.responders.insert(responder);
        return reply.code(201).send(responder);
    });

    app.patch<{ Params: { responderId: string } }>(RESPONDER_PATH, staff, async (req) => {
        const responder = await store.responders.get(req.params.responderId);
        if (!responder) throw notFound(`responder ${req.params.responderId}`);
        Object.assign(responder, parse(s.updateResponder, req.body), {
            updatedAt: iso(deps.now()),
        });
        await store.responders.put(responder);
        return responder;
    });

    app.get<{ Params: { zoneId: string } }>(ZONE_ASSIGNMENTS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        const q = parse(assignmentQuery, req.query, 'query');
        return store.assignments.list(
            { zoneId: req.params.zoneId as WatchZoneId, ...q },
            { orderBy: 'updatedAt', desc: true },
        );
    });

    app.post<{ Params: { zoneId: string } }>(ZONE_ASSIGNMENTS_PATH, staff, async (req) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.assignResponders, req.body);
        const result = await store.plannerResults.get(body.jobId);
        if (!result || result.zoneId !== zone.id) {
            throw notFound(`a result for planner job ${body.jobId} in zone ${zone.id}`);
        }
        const incident = body.incidentId ? await store.incidents.get(body.incidentId) : null;
        if (body.incidentId && !incident) throw notFound(`incident ${body.incidentId}`);
        const active = (await store.assignments.list({ zoneId: zone.id, state: 'active' })).filter(
            (a) => a.incidentId === (incident?.id ?? null),
        );
        const previous = new Map<string, PlannerResult>();
        for (const jobId of new Set(active.map((a) => a.jobId))) {
            const old = await store.plannerResults.get(jobId);
            if (old) previous.set(jobId, old);
        }
        const geo = await geographyOf(store, zone);
        const now = iso(deps.now());
        const out = assign({
            zoneId: zone.id,
            jobId: body.jobId,
            result,
            previous,
            responders: await store.responders.list({ zoneId: zone.id }),
            active,
            roads: geo.roads,
            areas: geo.civilianAreas,
            incident,
            attackZoneIds: body.attackZoneIds,
            perZone: body.perZone ?? 1,
            now,
        });
        for (const a of [...out.kept, ...out.superseded, ...out.created]) {
            await store.assignments.put(a);
        }
        const assignedIds = new Set([...out.kept, ...out.created].map((a) => a.responderId));
        for (const r of await store.responders.list({ zoneId: zone.id })) {
            const availability = assignedIds.has(r.id)
                ? 'assigned'
                : out.superseded.some((a) => a.responderId === r.id)
                  ? 'available'
                  : r.availability;
            if (availability !== r.availability) {
                await store.responders.put({ ...r, availability, updatedAt: now });
            }
        }
        if (incident && (out.created.length || out.superseded.length)) {
            await store.incidentEvents.insert({
                id: crypto.randomUUID(),
                incidentId: incident.id,
                kind: 'assignment',
                summary: `${out.created.length} assigned, ${out.superseded.length} superseded, ${out.kept.length} unchanged`,
                refs: { jobId: body.jobId },
                actor: 'api',
                at: now,
            });
        }
        const response: AssignRespondersResult = {
            assignments: [...out.kept, ...out.created],
            superseded: out.superseded,
            unassigned: out.unassigned,
        };
        return response;
    });

    app.get<{ Params: { zoneId: string } }>(ZONE_RESPONDER_MESSAGES_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        const q = parse(messageQuery, req.query, 'query');
        return store.responderMessages.list(
            {
                zoneId: req.params.zoneId as WatchZoneId,
                ...(q.responderId ? { responderId: q.responderId } : {}),
            },
            { orderBy: 'sentAt', desc: true, limit: 200 },
        );
    });

    app.post<{ Params: { zoneId: string } }>(
        ZONE_RESPONDER_MESSAGES_PATH,
        staff,
        async (req, reply) => {
            const zone = await requireZone(store, req.params.zoneId);
            const body = parse(s.responderMessage, req.body);
            if (body.responderId) {
                const r = await store.responders.get(body.responderId);
                if (!r || r.zoneId !== zone.id) throw notFound(`responder ${body.responderId}`);
            }
            const message: ResponderMessage = {
                id: crypto.randomUUID(),
                zoneId: zone.id,
                ...body,
                sentAt: iso(deps.now()),
            };
            await store.responderMessages.insert(message);
            return reply.code(201).send(message);
        },
    );

    app.post<{ Params: { zoneId: string } }>(
        RESPONDER_PAIRING_CODES_PATH,
        staff,
        async (req, reply) => {
            const zone = await requireZone(store, req.params.zoneId);
            const body = parse(s.pairingCode, req.body ?? {});
            if (body.responderId && !(await store.responders.get(body.responderId))) {
                throw notFound(`responder ${body.responderId}`);
            }
            const code: ResponderPairingCode = {
                kind: RESPONDER_PAIRING_KIND,
                v: 1,
                apiUrl: deps.config.publicApiUrl,
                zoneId: zone.id,
                zoneName: zone.name,
                token: token(),
                expiresAt: iso(new Date(deps.now().getTime() + PAIRING_TTL_MS)),
            };
            await store.pairingCodes.insert({
                token: code.token,
                zoneId: zone.id,
                responderId: body.responderId ?? null,
                expiresAt: code.expiresAt,
            });
            return reply.code(201).send(code);
        },
    );

    app.post(RESPONDER_PAIR_PATH, async (req, reply) => {
        const body = parse(s.pair, req.body);
        const code = await store.pairingCodes.get(body.token);
        if (!code || Date.parse(code.expiresAt) < deps.now().getTime()) {
            throw new HttpError(401, 'pairing code is unknown or expired');
        }
        await store.pairingCodes.remove(code.token);
        const zone = await requireZone(store, code.zoneId);
        let responderId = code.responderId;
        if (!responderId) {
            const responder: Responder = {
                id: crypto.randomUUID(),
                number: await store.counters.next('responder'),
                zoneId: zone.id,
                name: body.deviceName,
                role: 'responder',
                capabilities: [],
                stationId: null,
                location: null,
                availability: 'available',
                status: 'idle',
                updatedAt: iso(deps.now()),
            };
            await store.responders.insert(responder);
            responderId = responder.id;
        }
        const session: ResponderSession = {
            responderId,
            sessionToken: token(),
            zoneId: zone.id,
            zoneName: zone.name,
            apiUrl: deps.config.publicApiUrl,
            droneInfoUrl: deps.config.droneInfoUrl,
        };
        await store.sessions.insert({
            sessionToken: session.sessionToken,
            responderId,
            zoneId: zone.id,
            createdAt: iso(deps.now()),
        });
        return reply.code(201).send(session);
    });

    app.get<{ Params: { zoneId: string } }>(RESPONDER_BUNDLE_PATH, async (req, reply) => {
        const header = req.headers.authorization ?? '';
        const session = header.startsWith('Bearer ')
            ? await store.sessions.get(header.slice(7))
            : null;
        if (!session || session.zoneId !== req.params.zoneId) {
            throw new HttpError(401, 'responder session required for this zone');
        }
        const zone = await requireZone(store, session.zoneId);
        const ctx = await plannerContext(deps, zone);
        const [latest] = await store.plannerJobs.list(
            { zoneId: zone.id, state: 'succeeded' },
            { orderBy: 'updatedAt', desc: true, limit: 1 },
        );
        const result = latest ? await store.plannerResults.get(latest.jobId) : null;
        const plan: ResponderPlan | null = result && {
            jobId: result.jobId,
            generatedAt: result.generatedAt,
            horizonMin: result.horizonMin,
            isochrones: result.fireSpread.isochrones,
            track: result.fireSpread.track,
            headingDeg: result.fireSpread.headingDeg,
            maxSpreadMpm: result.fireSpread.maxSpreadMpm,
            attackZones: result.attackZones,
        };
        const messages = (
            await store.responderMessages.list(
                { zoneId: zone.id },
                { orderBy: 'sentAt', desc: true, limit: 500 },
            )
        )
            .filter((m) => m.responderId === null || m.responderId === session.responderId)
            .slice(0, BUNDLE_MESSAGES);
        const [assignment] = await store.assignments.list({
            responderId: session.responderId,
            state: 'active',
        });
        const content = {
            zoneId: zone.id,
            name: zone.name,
            boundary: zone.boundary,
            terrain: ctx.terrain,
            roads: ctx.roads,
            civilianAreas: ctx.civilianAreas,
            safeZones: ctx.safeZones,
            stations: ctx.stations,
            weather: ctx.weather,
            riskZones: ctx.riskZones,
            detections: ctx.detections,
            plan,
            messages,
            assignment: assignment ?? null,
        };
        const version = createHash('sha256')
            .update(
                JSON.stringify({
                    ...content,
                    weather: ctx.weather && { ...ctx.weather, observedAt: null },
                }),
            )
            .digest('base64url')
            .slice(0, 22);
        reply.header('etag', `"${version}"`);
        const match = req.headers['if-none-match']?.replaceAll('"', '');
        if (match === version) return reply.code(304).send();
        const bundle: ResponderZoneBundle = { ...content, version, generatedAt: iso(deps.now()) };
        return bundle;
    });
}
