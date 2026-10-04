import type { FastifyReply, FastifyRequest } from 'fastify';
import { isDbError } from './db.js';

export const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ error: `${what} not found` });

export const conflict = (reply: FastifyReply, error: string) => reply.code(409).send({ error });

/** Awaits a write on one row; null when the row does not exist. */
export async function orMissing<T>(write: PromiseLike<T>): Promise<T | null> {
    try {
        return await write;
    } catch (err) {
        if (isDbError(err, 'P2025')) return null;
        throw err;
    }
}

/** A preValidation hook for bodies whose every field is optional: no body is `{}`. */
export async function optionalBody(req: FastifyRequest) {
    req.body ??= {};
}
