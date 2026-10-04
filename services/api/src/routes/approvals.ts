import type { FastifyInstance } from 'fastify';
import {
    APPROVAL_DECISION_PATH,
    APPROVAL_PATH,
    APPROVALS_PATH,
    type Approval,
    type WatchZoneId,
} from '@ember/contracts';
import { z } from 'zod';
import { guard, STAFF } from '../auth.js';
import { iso, requireZone, type Deps } from '../deps.js';
import { HttpError, notFound, parse } from '../errors.js';
import * as s from '../schemas.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function confirmationCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const listQuery = z.object({
    state: z.enum(['pending', 'approved', 'rejected', 'sent']).optional(),
    zoneId: z.string().optional(),
});

export function approvalRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    async function requireApproval(id: string): Promise<Approval> {
        const approval = await store.approvals.get(id);
        if (!approval) throw notFound(`approval ${id}`);
        return approval;
    }

    app.get(APPROVALS_PATH, staff, async (req) => {
        const q = parse(listQuery, req.query, 'query');
        return store.approvals.list(
            {
                ...(q.state ? { state: q.state } : {}),
                ...(q.zoneId ? { zoneId: q.zoneId as WatchZoneId } : {}),
            },
            { orderBy: 'number', desc: true },
        );
    });

    app.post(APPROVALS_PATH, staff, async (req, reply) => {
        const body = parse(s.createApproval, req.body);
        const zone = await requireZone(store, body.zoneId);
        if (body.draft.kind === 'civilian_alert') {
            for (const r of body.draft.recipients) {
                if (!(await store.civilians.get(r.civilianId))) {
                    throw notFound(`civilian ${r.civilianId}`);
                }
            }
        }
        const approval: Approval = {
            id: crypto.randomUUID(),
            number: await store.counters.next('approval'),
            zoneId: zone.id,
            incidentId: body.incidentId ?? null,
            state: 'pending',
            draft: body.draft,
            reason: body.reason,
            draftedBy: body.draftedBy,
            confirmationCode: confirmationCode(),
            createdAt: iso(deps.now()),
            decidedBy: null,
            decidedVia: null,
            decidedAt: null,
            decisionNote: null,
        };
        await store.approvals.insert(approval);
        return reply.code(201).send(approval);
    });

    app.get<{ Params: { approvalId: string } }>(APPROVAL_PATH, staff, async (req) =>
        requireApproval(req.params.approvalId),
    );

    app.post<{ Params: { approvalId: string } }>(
        APPROVAL_DECISION_PATH,
        { preHandler: guard(deps.keys, ['operator']) },
        async (req) => {
            const approval = await requireApproval(req.params.approvalId);
            const body = parse(s.approvalDecision, req.body);
            if (approval.state !== 'pending') {
                throw new HttpError(409, `approval ${approval.number} is ${approval.state}`);
            }
            if (body.confirmationCode.toUpperCase() !== approval.confirmationCode) {
                throw new HttpError(409, `wrong confirmation code for approval ${approval.number}`);
            }
            approval.state = body.decision === 'approve' ? 'approved' : 'rejected';
            approval.decidedBy = body.operator;
            approval.decidedVia = body.via;
            approval.decidedAt = iso(deps.now());
            approval.decisionNote = body.note ?? null;
            await store.approvals.put(approval);
            return approval;
        },
    );
}
