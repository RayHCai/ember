import type { FastifyInstance } from 'fastify';
import {
    CIVILIAN_INBOUND_PATH,
    CIVILIAN_MESSAGE_PATH,
    CIVILIAN_MESSAGES_PATH,
    CIVILIAN_PATH,
    CIVILIANS_PATH,
    ZONE_CIVILIANS_PATH,
    type CivilianMessage,
    type CreateCivilianRequest,
    type InboundCivilianMessageResult,
} from '@ember/contracts';
import { z } from 'zod';
import { guard, STAFF } from '../auth.js';
import { iso, requireZone, type Deps } from '../deps.js';
import { HttpError, notFound, parse } from '../errors.js';
import * as s from '../schemas.js';
import { DuplicateError, type CivilianPatch } from '../store/index.js';

const createBody = {
    type: 'object',
    required: ['email', 'zipCode'],
    additionalProperties: false,
    properties: {
        email: { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$' },
        zipCode: { type: 'string', pattern: '^[0-9]{5}$' },
    },
} as const;

/** A civilian who wrote within this window has an open conversation Ember may reply in. */
export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

const listQuery = z.object({ email: z.string().optional() });
const messageQuery = z.object({
    civilianId: z.string().optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    status: z.enum(['received', 'queued', 'sent', 'failed']).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
});

export function civilianRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    app.post<{ Body: CreateCivilianRequest }>(
        CIVILIANS_PATH,
        { schema: { body: createBody } },
        async (req, reply) => {
            try {
                const civilian = await store.civilians.create({
                    email: req.body.email.toLowerCase(),
                    zipCode: req.body.zipCode,
                });
                return reply.code(201).send(civilian);
            } catch (err) {
                if (err instanceof DuplicateError) {
                    return reply.code(409).send({ error: 'email already registered' });
                }
                throw err;
            }
        },
    );

    app.get('/v1/civilians', staff, async (req) => {
        const q = parse(listQuery, req.query, 'query');
        return store.civilians.list(q.email ? { email: q.email.toLowerCase() } : {});
    });

    app.get<{ Params: { civilianId: string } }>(CIVILIAN_PATH, staff, async (req) => {
        const civilian = await store.civilians.get(req.params.civilianId);
        if (!civilian) throw notFound(`civilian ${req.params.civilianId}`);
        return civilian;
    });

    app.patch<{ Params: { civilianId: string } }>(CIVILIAN_PATH, staff, async (req) => {
        const body = parse(s.updateCivilian, req.body);
        const patch: CivilianPatch = { ...body };
        if (body.civilianAreaId !== undefined) {
            patch.zoneId = null;
            if (body.civilianAreaId) {
                const geos = await store.geography.list();
                const geo = geos.find((g) =>
                    g.civilianAreas.some((a) => a.id === body.civilianAreaId),
                );
                if (!geo) throw notFound(`civilian area ${body.civilianAreaId}`);
                patch.zoneId = geo.zoneId;
            }
        }
        const civilian = await store.civilians.update(req.params.civilianId, patch);
        if (!civilian) throw notFound(`civilian ${req.params.civilianId}`);
        return civilian;
    });

    app.get<{ Params: { zoneId: string } }>(ZONE_CIVILIANS_PATH, staff, async (req) => {
        const zone = await requireZone(store, req.params.zoneId);
        return store.civilians.list({ zoneId: zone.id });
    });

    app.post(CIVILIAN_INBOUND_PATH, staff, async (req, reply) => {
        const body = parse(s.inboundCivilianMessage, req.body);
        const [civilian] = await store.civilians.list({ email: body.handle.toLowerCase() });
        if (!civilian) throw new HttpError(404, `no civilian with handle ${body.handle}`);
        const now = iso(deps.now());
        const message: CivilianMessage = {
            id: crypto.randomUUID(),
            civilianId: civilian.id,
            direction: 'inbound',
            channel: body.channel,
            body: body.body,
            attachments: body.attachments,
            approvalId: null,
            inReplyTo: null,
            jobId: null,
            status: 'received',
            error: null,
            createdAt: now,
            sentAt: null,
        };
        await store.civilianMessages.insert(message);
        const out: InboundCivilianMessageResult = { civilian, message };
        return reply.code(201).send(out);
    });

    app.get(CIVILIAN_MESSAGES_PATH, staff, async (req) => {
        const q = parse(messageQuery, req.query, 'query');
        const all = await store.civilianMessages.list(
            {
                ...(q.civilianId ? { civilianId: q.civilianId } : {}),
                ...(q.direction ? { direction: q.direction } : {}),
                ...(q.status ? { status: q.status } : {}),
            },
            { orderBy: 'createdAt' },
        );
        return q.since ? all.filter((m) => m.createdAt > iso(new Date(q.since!))) : all;
    });

    app.post(CIVILIAN_MESSAGES_PATH, staff, async (req, reply) => {
        const body = parse(s.queueCivilianMessage, req.body);
        const civilian = await store.civilians.get(body.civilianId);
        if (!civilian) throw notFound(`civilian ${body.civilianId}`);
        if (!body.approvalId === !body.inReplyTo) {
            throw new HttpError(
                403,
                'an outbound message needs exactly one of approvalId or inReplyTo',
            );
        }
        const now = deps.now();
        let approval = null;
        if (body.approvalId) {
            approval = await store.approvals.get(body.approvalId);
            if (!approval || approval.draft.kind !== 'civilian_alert') {
                throw new HttpError(403, `approval ${body.approvalId} is not a civilian alert`);
            }
            if (approval.state !== 'approved' && approval.state !== 'sent') {
                throw new HttpError(403, `approval ${approval.number} is ${approval.state}`);
            }
            const entry = approval.draft.recipients.find((r) => r.civilianId === civilian.id);
            if (!entry || entry.body !== body.body) {
                throw new HttpError(
                    403,
                    `approval ${approval.number} does not cover this text for civilian ${civilian.number}`,
                );
            }
            const already = await store.civilianMessages.list({
                approvalId: approval.id,
                civilianId: civilian.id,
            });
            if (already.length) {
                throw new HttpError(409, `civilian ${civilian.number} already has this alert`);
            }
        } else {
            const inbound = await store.civilianMessages.get(body.inReplyTo!);
            if (
                !inbound ||
                inbound.direction !== 'inbound' ||
                inbound.civilianId !== civilian.id ||
                now.getTime() - Date.parse(inbound.createdAt) > CONVERSATION_WINDOW_MS
            ) {
                throw new HttpError(
                    403,
                    `message ${body.inReplyTo} is not a recent message from civilian ${civilian.number}`,
                );
            }
        }
        const message: CivilianMessage = {
            id: crypto.randomUUID(),
            civilianId: civilian.id,
            direction: 'outbound',
            channel: body.channel,
            body: body.body,
            attachments: [],
            approvalId: body.approvalId ?? null,
            inReplyTo: body.inReplyTo ?? null,
            jobId: body.jobId ?? null,
            status: 'queued',
            error: null,
            createdAt: iso(now),
            sentAt: null,
        };
        await store.civilianMessages.insert(message);
        if (approval && approval.draft.kind === 'civilian_alert' && approval.state === 'approved') {
            const sent = await store.civilianMessages.list({ approvalId: approval.id });
            const covered = new Set(sent.map((m) => m.civilianId));
            if (approval.draft.recipients.every((r) => covered.has(r.civilianId))) {
                approval.state = 'sent';
                await store.approvals.put(approval);
            }
        }
        return reply.code(201).send(message);
    });

    app.patch<{ Params: { messageId: string } }>(CIVILIAN_MESSAGE_PATH, staff, async (req) => {
        const message = await store.civilianMessages.get(req.params.messageId);
        if (!message || message.direction !== 'outbound') {
            throw notFound(`outbound message ${req.params.messageId}`);
        }
        const body = parse(s.civilianDelivery, req.body);
        message.status = body.status;
        message.error = body.error ?? null;
        if (body.status === 'sent') message.sentAt = iso(deps.now());
        await store.civilianMessages.put(message);
        return message;
    });
}
