import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly body: Record<string, unknown> = {},
    ) {
        super(message);
    }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function parse<S extends z.ZodType>(schema: S, value: unknown, what = 'body'): z.infer<S> {
    const result = schema.safeParse(value);
    if (!result.success) {
        const issues = result.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || what}: ${i.message}`);
        throw new HttpError(400, `invalid ${what}: ${issues.join('; ')}`);
    }
    return result.data;
}

export function errorHandler(app: FastifyInstance) {
    app.setErrorHandler((err, req, reply) => {
        if (err instanceof HttpError) {
            return reply.code(err.status).send({ error: err.message, ...err.body });
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status < 500) {
            return reply.code(status).send({ error: (err as Error).message });
        }
        req.log.error(err);
        return reply.code(500).send({ error: 'internal error' });
    });
}
