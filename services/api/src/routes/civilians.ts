import type { FastifyInstance } from 'fastify';
import type { Civilian, CreateCivilianRequest } from '@ember/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../db.js';

const createBody = {
    type: 'object',
    required: ['email', 'zipCode'],
    additionalProperties: false,
    properties: {
        email: { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$' },
        zipCode: { type: 'string', pattern: '^[0-9]{5}$' },
    },
} as const;

export function civilianRoutes(app: FastifyInstance, db: Db) {
    app.post<{ Body: CreateCivilianRequest }>(
        '/civilians',
        { schema: { body: createBody } },
        async (req, reply) => {
            try {
                const row = await db.civilian.create({
                    data: { email: req.body.email.toLowerCase(), zipCode: req.body.zipCode },
                });
                const civilian: Civilian = {
                    id: row.id,
                    email: row.email,
                    zipCode: row.zipCode,
                    createdAt: row.createdAt.toISOString(),
                };
                return reply.code(201).send(civilian);
            } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                    return reply.code(409).send({ error: 'email already registered' });
                }
                throw err;
            }
        },
    );
}
