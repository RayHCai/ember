import type { FastifyInstance } from 'fastify';
import type { Civilian, CreateCivilianRequest } from '@ember/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../db.js';

const createBody = {
    type: 'object',
    required: ['phone', 'zipCode'],
    additionalProperties: false,
    properties: {
        phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
        zipCode: { type: 'string', pattern: '^[0-9]{5}$' },
    },
} as const;

export function civilianRoutes(app: FastifyInstance, db: Db) {
    app.post<{ Body: CreateCivilianRequest }>(
        '/civilians',
        { schema: { body: createBody } },
        async (req, reply) => {
            try {
                const row = await db.civilian.create({ data: req.body });
                const civilian: Civilian = {
                    id: row.id,
                    phone: row.phone,
                    zipCode: row.zipCode,
                    createdAt: row.createdAt.toISOString(),
                };
                return reply.code(201).send(civilian);
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                    return reply.code(409).send({ error: 'phone already registered' });
                }
                throw err;
            }
        },
    );
}
