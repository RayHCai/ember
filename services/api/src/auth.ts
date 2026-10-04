import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_DAYS } from '@ember/contracts';
import type { Db } from './db.js';

export type ApiKeys = { edge?: string; planner?: string; agent?: string };

export type ServiceName = keyof ApiKeys;

export type SignedInOperator = { id: string; email: string; name: string; createdAt: Date };

/** Who made a `/v1` request: a signed-in operator, a service with a key, or anyone (no keys set). */
export type Caller =
    | { kind: 'operator'; operator: SignedInOperator; sessionId: string; expiresAt: Date }
    | { kind: 'service'; service: ServiceName }
    | { kind: 'open' };

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by `authenticate`; null outside the `/v1` bearer scope. */
        caller: Caller | null;
    }
}

const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const digest = (key: string) => createHash('sha256').update(key).digest();

function scryptKey(
    password: string,
    salt: Buffer,
    bytes: number,
    { N, r, p }: { N: number; r: number; p: number },
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, bytes, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
            err ? reject(err) : resolve(key),
        );
    });
}

/** `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const hash = await scryptKey(password, salt, KEY_BYTES, SCRYPT);
    const { N, r, p } = SCRYPT;
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
    if (!Object.values(params).every((v) => Number.isInteger(v) && v > 0)) return false;
    const expected = Buffer.from(hash, 'base64');
    if (expected.length === 0) return false;
    const got = await scryptKey(password, Buffer.from(salt, 'base64'), expected.length, params);
    return timingSafeEqual(expected, got);
}

/** The stored id of a session: its token is a bearer secret, so only the hash is kept. */
export const sessionId = (token: string) => createHash('sha256').update(token).digest('hex');

export function newSession(now = new Date()) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 3600 * 1000);
    return { token, id: sessionId(token), expiresAt };
}

const bearer = (req: FastifyRequest) =>
    /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

async function operatorSession(db: Db, token: string): Promise<Caller | null> {
    if (!SESSION_TOKEN.test(token)) return null;
    const id = sessionId(token);
    const row = await db.operatorSession.findUnique({
        where: { id },
        select: {
            expiresAt: true,
            operator: { select: { id: true, email: true, name: true, createdAt: true } },
        },
    });
    if (!row || row.expiresAt <= new Date()) return null;
    return { kind: 'operator', operator: row.operator, sessionId: id, expiresAt: row.expiresAt };
}

/**
 * The `/v1` preHandler: admits a service key or an unexpired operator session and records who
 * called on `req.caller`. With no keys set every request is admitted (local dev; main logs a
 * warning), but a valid session still identifies its operator.
 */
export function authenticate(db: Db, keys: ApiKeys) {
    const serviceKeys = (['edge', 'planner', 'agent'] as const)
        .filter((name) => Boolean(keys[name]))
        .map((name) => ({ name, key: digest(keys[name]!) }));
    return async (req: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(req);
        if (token !== null) {
            const got = digest(token);
            const service = serviceKeys.find(({ key }) => timingSafeEqual(key, got));
            if (service) {
                req.caller = { kind: 'service', service: service.name };
                return;
            }
            const session = await operatorSession(db, token);
            if (session) {
                req.caller = session;
                return;
            }
        }
        if (serviceKeys.length === 0) {
            req.caller = { kind: 'open' };
            return;
        }
        return reply.code(401).send({ error: 'missing or wrong bearer token' });
    };
}

/**
 * A preHandler admitting requests whose bearer token is one of `keys`. Unset keys are skipped, and
 * with none set every request is admitted (local dev; main logs a warning).
 */
export function requireBearer(keys: (string | undefined)[]) {
    const allowed = keys.filter((k): k is string => Boolean(k)).map(digest);
    return async (req: FastifyRequest, reply: FastifyReply) => {
        if (allowed.length === 0) return;
        const token = bearer(req);
        const got = token === null ? null : digest(token);
        if (!got || !allowed.some((key) => timingSafeEqual(key, got))) {
            return reply.code(401).send({ error: 'missing or wrong bearer key' });
        }
    };
}

/** The signed-in operator behind a request, if any. */
export function operatorOf(req: FastifyRequest) {
    return req.caller?.kind === 'operator' ? req.caller : null;
}
