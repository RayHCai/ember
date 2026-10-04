import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

/**
 * Who may call a route. `operator`: dashboard and approval decisions. `agent`: operator-agent.
 * `planner`: the planner orchestrator. `ingest`: drone-info forwarding detections.
 */
export type Role = 'operator' | 'agent' | 'planner' | 'ingest';

export type Keys = Partial<Record<Role, string>>;

export const STAFF: Role[] = ['operator', 'agent'];

export function keysFromEnv(env: NodeJS.ProcessEnv): Keys {
    const keys: Keys = {
        operator: env.EMBER_OPERATOR_KEY,
        agent: env.EMBER_AGENT_KEY,
        planner: env.EMBER_PLANNER_KEY,
        ingest: env.EMBER_INGEST_KEY,
    };
    return Object.fromEntries(Object.entries(keys).filter(([, v]) => v)) as Keys;
}

/**
 * Accepts a bearer matching any allowed role's key. A route none of whose roles has a key set is
 * open, so local development needs no keys; main.ts warns about every role left open.
 */
export function guard(keys: Keys, roles: Role[]) {
    const accepted = roles.map((r) => keys[r]).filter((k): k is string => !!k);
    return async (req: FastifyRequest) => {
        if (!accepted.length) return;
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!accepted.includes(token)) throw new HttpError(401, `requires ${roles.join(' or ')}`);
    };
}
