import type { FastifyInstance } from 'fastify';
import { SESSION_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from '@ember/contracts';
import type {
    Operator,
    OperatorSession,
    SessionInfo,
    SignInRequest,
    SignUpRequest,
} from '@ember/contracts';
import {
    hashPassword,
    newSession,
    operatorOf,
    verifyPassword,
    type SignedInOperator,
} from '../auth.js';
import { isDbError, type Db } from '../db.js';
import { conflict } from '../http.js';

const email = { type: 'string', format: 'email', maxLength: 254 } as const;
const password = { type: 'string', minLength: 8, maxLength: 200 } as const;

export function operatorWire(row: SignedInOperator): Operator {
    return {
        operatorId: row.id,
        email: row.email,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
    };
}

const normalEmail = (raw: string) => raw.trim().toLowerCase();

// Compared against when the email is unknown, so both mistakes take as long.
let decoyHash: Promise<string> | null = null;

/** Sign-up and sign-in: open, outside the bearer scope. */
export function signInRoutes(app: FastifyInstance, db: Db) {
    app.post<{ Body: SignUpRequest }>(
        SIGN_UP_PATH,
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['email', 'name', 'password'],
                    additionalProperties: false,
                    properties: {
                        email,
                        name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
                        password,
                    },
                },
            },
        },
        async (req, reply) => {
            const session = newSession();
            try {
                const row = await db.operator.create({
                    data: {
                        email: normalEmail(req.body.email),
                        name: req.body.name.trim(),
                        passwordHash: await hashPassword(req.body.password),
                        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
                    },
                });
                const body: OperatorSession = {
                    token: session.token,
                    operator: operatorWire(row),
                    expiresAt: session.expiresAt.toISOString(),
                };
                return reply.code(201).send(body);
            } catch (err) {
                if (isDbError(err, 'P2002')) return conflict(reply, 'email already registered');
                throw err;
            }
        },
    );

    app.post<{ Body: SignInRequest }>(
        SIGN_IN_PATH,
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['email', 'password'],
                    additionalProperties: false,
                    properties: { email, password: { type: 'string', maxLength: 200 } },
                },
            },
        },
        async (req, reply) => {
            const row = await db.operator.findUnique({
                where: { email: normalEmail(req.body.email) },
            });
            decoyHash ??= hashPassword('decoy password');
            const ok = await verifyPassword(
                req.body.password,
                row?.passwordHash ?? (await decoyHash),
            );
            if (!row || !ok) return reply.code(401).send({ error: 'wrong email or password' });
            const session = newSession();
            await db.operatorSession.create({
                data: { id: session.id, operatorId: row.id, expiresAt: session.expiresAt },
            });
            const body: OperatorSession = {
                token: session.token,
                operator: operatorWire(row),
                expiresAt: session.expiresAt.toISOString(),
            };
            return body;
        },
    );
}

/** The caller's own session; inside the bearer scope, operators only. */
export function sessionRoutes(app: FastifyInstance, db: Db) {
    app.get(SESSION_PATH, async (req, reply) => {
        const caller = operatorOf(req);
        if (!caller) return reply.code(401).send({ error: 'not signed in as an operator' });
        const info: SessionInfo = {
            operator: operatorWire(caller.operator),
            expiresAt: caller.expiresAt.toISOString(),
        };
        return info;
    });

    app.delete(SESSION_PATH, async (req, reply) => {
        const caller = operatorOf(req);
        if (!caller) return reply.code(401).send({ error: 'not signed in as an operator' });
        await db.operatorSession.deleteMany({ where: { id: caller.sessionId } });
        return reply.code(204).send();
    });
}
