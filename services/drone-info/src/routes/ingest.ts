import type { FastifyInstance } from 'fastify';
import { DRONE_INFO_INGEST_PATH } from '@ember/contracts';
import type { DroneInfoIngestResult } from '@ember/contracts';
import type { Fleet } from '../fleet.js';
import { parseReported } from '../validate.js';

const body = {
    type: 'object',
    required: ['messages'],
    properties: { messages: { type: 'array', maxItems: 5000 } },
} as const;

/** Errors listed back per batch, so one noisy drone cannot make the reply huge. */
const MAX_ERRORS = 20;

export function ingestRoutes(app: FastifyInstance, fleet: Fleet) {
    app.post<{ Body: { messages: unknown[] } }>(
        DRONE_INFO_INGEST_PATH,
        { schema: { body } },
        (req, reply) => {
            const result: DroneInfoIngestResult = { accepted: 0, rejected: 0, errors: [] };
            for (const raw of req.body.messages) {
                const parsed = parseReported(raw);
                if ('message' in parsed) {
                    fleet.ingest(parsed.message);
                    result.accepted += 1;
                } else {
                    result.rejected += 1;
                    if (result.errors.length < MAX_ERRORS) result.errors.push(parsed.error);
                }
            }
            if (result.rejected)
                req.log.warn({ errors: result.errors }, 'ingest: rejected messages');
            return reply.send(result);
        },
    );
}
