import type { FastifyInstance } from 'fastify';
import { BLASTS_PATH, ZONE_BLASTS_PATH } from '@ember/contracts';
import type { Blast, CreateBlastRequest, WatchZoneId } from '@ember/contracts';
import type { Blast as BlastRow } from '../generated/prisma/client.js';
import { operatorOf } from '../auth.js';
import { isDbError, type Db } from '../db.js';
import { notFound } from '../http.js';
import { limit, uuid } from '../schemas.js';

const zoneParams = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;
const blastParams = {
    type: 'object',
    required: ['blastId'],
    properties: { blastId: uuid },
} as const;

type ZoneParams = { zoneId: string };

export function blastWire(row: BlastRow): Blast {
    return {
        blastId: row.id,
        zoneId: row.zoneId as WatchZoneId,
        audience: row.audience,
        priority: row.priority,
        area: row.area,
        title: row.title,
        body: row.body,
        state: row.state,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        approval:
            row.approvedBy !== null && row.approverName !== null && row.approvedAt !== null
                ? {
                      approvedBy: row.approvedBy,
                      approverName: row.approverName,
                      approvedAt: row.approvedAt.toISOString(),
                  }
                : null,
    };
}

/**
 * Blasts to a zone. One that reaches civilians is `queued` only with a signed-in operator's
 * approval (docs/development.md: human in the loop); the migration's check constraint holds the
 * same line.
 */
export function blastRoutes(app: FastifyInstance, db: Db) {
    app.post<{ Params: ZoneParams; Body: CreateBlastRequest }>(
        ZONE_BLASTS_PATH,
        {
            schema: {
                params: zoneParams,
                body: {
                    type: 'object',
                    required: ['audience', 'priority', 'area', 'title', 'body'],
                    additionalProperties: false,
                    properties: {
                        audience: { enum: ['civilians', 'responders', 'both'] },
                        priority: { enum: ['routine', 'urgent', 'critical'] },
                        area: { enum: ['zone', 'near_fire'] },
                        title: { type: 'string', minLength: 1, maxLength: 120 },
                        body: { type: 'string', minLength: 1, maxLength: 1000 },
                        approve: { type: 'boolean' },
                    },
                },
            },
        },
        async (req, reply) => {
            const { approve = false, ...blast } = req.body;
            const caller = operatorOf(req);
            const approval =
                blast.audience !== 'responders' && approve && caller
                    ? {
                          approvedBy: caller.operator.id,
                          approverName: caller.operator.name,
                          approvedAt: new Date(),
                      }
                    : null;
            const queued = blast.audience === 'responders' || approval !== null;
            try {
                const row = await db.blast.create({
                    data: {
                        ...blast,
                        ...approval,
                        zoneId: req.params.zoneId,
                        state: queued ? 'queued' : 'pending_approval',
                        createdBy: caller?.operator.id ?? 'service',
                    },
                });
                return reply.code(201).send(blastWire(row));
            } catch (err) {
                if (isDbError(err, 'P2003'))
                    return notFound(reply, `watch zone ${req.params.zoneId}`);
                throw err;
            }
        },
    );

    app.get<{ Params: ZoneParams; Querystring: { limit: number } }>(
        ZONE_BLASTS_PATH,
        { schema: { params: zoneParams, querystring: { type: 'object', properties: { limit } } } },
        async (req, reply) => {
            const rows = await db.blast.findMany({
                where: { zoneId: req.params.zoneId },
                orderBy: { createdAt: 'desc' },
                take: req.query.limit,
            });
            return reply.send(rows.map(blastWire));
        },
    );

    // Approving twice, or a responder-only blast, answers the blast as it is.
    app.post<{ Params: { blastId: string } }>(
        `${BLASTS_PATH}/:blastId/approve`,
        { schema: { params: blastParams } },
        async (req, reply) => {
            const caller = operatorOf(req);
            if (!caller) {
                return reply
                    .code(403)
                    .send({ error: 'only a signed-in operator can approve a blast' });
            }
            const { blastId } = req.params;
            await db.blast.updateMany({
                where: { id: blastId, state: 'pending_approval' },
                data: {
                    state: 'queued',
                    approvedBy: caller.operator.id,
                    approverName: caller.operator.name,
                    approvedAt: new Date(),
                },
            });
            const row = await db.blast.findUnique({ where: { id: blastId } });
            return row ? blastWire(row) : notFound(reply, `blast ${blastId}`);
        },
    );
}
