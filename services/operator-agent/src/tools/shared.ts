import type { Responder } from '@ember/contracts';
import { z } from 'zod';
import { AgentError, geography, resolveZone, type Ctx } from '../context.js';
import { currentPlan } from '../playbooks/insight.js';
import { openIncidents } from '../playbooks/response.js';

export const zoneArg = z
    .string()
    .optional()
    .describe('Watch zone name or id; omit for the only/first zone');
export const jobArg = z.string().optional().describe('Planner job id; omit for the current plan');

export async function plan(ctx: Ctx, zoneRef: string | undefined, jobId: string | undefined) {
    const zone = await resolveZone(ctx, zoneRef);
    const view = jobId ? await ctx.api.plan(jobId) : await currentPlan(ctx, zone);
    if (!view?.result)
        throw new AgentError(`${zone.name} has no finished plan; run the planner first`);
    return { zone, result: view.result, geo: await geography(ctx, zone.id) };
}

export async function responderByNumber(ctx: Ctx, zoneId: string, n: number): Promise<Responder> {
    const r = (await ctx.api.responders(zoneId)).find((x) => x.number === n);
    if (!r) throw new AgentError(`Responder ${n} is not in this zone`);
    return r;
}

export async function incidentFor(ctx: Ctx, zoneId: string, number?: number) {
    const open = await openIncidents(ctx, zoneId);
    const incident = number ? open.find((i) => i.number === number) : open[0];
    if (!incident)
        throw new AgentError(
            number ? `no open Incident #${number}` : 'no open incident in this zone',
        );
    return incident;
}
