import type { FastifyInstance } from 'fastify';
import { CIVILIANS_PATH } from '@ember/contracts';
import type { Civilian, CreateCivilianRequest } from '@ember/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../db.js';

const zipCode = { type: 'string', pattern: '^[0-9]{5}$' } as const;

const civilianWire = (row: { id: string; phone: string; zipCode: string; createdAt: Date }) =>
    ({
        id: row.id,
        phone: row.phone,
        zipCode: row.zipCode,
        createdAt: row.createdAt.toISOString(),
    }) satisfies Civilian;

const createBody = {
    type: 'object',
    required: ['phone', 'zipCode'],
    additionalProperties: false,
    properties: {
        phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
        zipCode,
    },
} as const;

export function civilianRoutes(app: FastifyInstance, db: Db) {
    app.post<{ Body: CreateCivilianRequest }>(
        '/civilians',
        { schema: { body: createBody } },
        async (req, reply) => {
            try {
                const row = await db.civilian.create({ data: req.body });
                return reply.code(201).send(civilianWire(row));
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                    return reply.code(409).send({ error: 'phone already registered' });
                }
                throw err;
            }
        },
    );
}

/**
 * Phone numbers by ZIP, for operator-agent to text an approved alert. Only the agent key reads
 * them, so an operator session or another service's key cannot list civilians.
 */
export function civilianDirectoryRoutes(app: FastifyInstance, db: Db) {
    app.get<{ Querystring: { zipCode: string } }>(
        CIVILIANS_PATH,
        {
            schema: {
                querystring: {
                    type: 'object',
                    required: ['zipCode'],
                    additionalProperties: false,
                    properties: { zipCode },
                },
            },
        },
        async (req, reply) => {
            const caller = req.caller;
            const agent = caller?.kind === 'service' && caller.service === 'agent';
            if (!agent && caller?.kind !== 'open') {
                return reply.code(403).send({ error: 'only operator-agent can list civilians' });
            }
            const rows = await db.civilian.findMany({
                where: { zipCode: req.query.zipCode },
                orderBy: { createdAt: 'asc' },
            });
            return reply.send(rows.map(civilianWire));
        },
    );
}
