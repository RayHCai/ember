import type { Decision, PlannerJobView, PlannerOptions, WatchZone } from '@ember/contracts';
import { ApiError, type ApiClient } from './api.js';
import type { CivilianTransport } from './channels.js';
import type { AgentConfig } from './config.js';
import type { Reasoner } from './llm/reasoner.js';
import type { GeminiMapImager } from './map/imagery.js';
import type { AgentMemory } from './memory.js';
import type { Geography } from './views.js';

export type Log = {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
};

export type Ctx = {
    api: ApiClient;
    memory: AgentMemory;
    /** Claude; null without a key, and language falls back to templates and rules. */
    reasoner: Reasoner | null;
    /** Gemini, for map images only; null sends the deterministic render. */
    imager: GeminiMapImager | null;
    transport: CivilianTransport;
    config: AgentConfig;
    log: Log;
    /** Place name to coordinates from a geocoding service; never from the model. */
    geocode: (place: string) => Promise<{ lat: number; lng: number; label: string } | null>;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
};

export const EMBER = 'ember';

export type DecisionInput = Omit<Decision, 'id' | 'number' | 'at'>;

export async function decide(ctx: Ctx, d: DecisionInput): Promise<Decision> {
    const decision = await ctx.memory.addDecision(d, ctx.now().toISOString());
    ctx.log.info(
        { decision: decision.number, kind: d.kind, zoneId: d.zoneId, confidence: d.confidence },
        d.summary,
    );
    return decision;
}

export class AgentError extends Error {}

/** A zone by id, by name (ignoring case), or the only zone there is. */
export async function resolveZone(ctx: Ctx, ref?: string | null): Promise<WatchZone> {
    const zones = await ctx.api.zones();
    if (ref) {
        const r = ref.trim().toLowerCase();
        const found =
            zones.find((z) => z.id === ref) ??
            zones.find((z) => z.name.toLowerCase() === r) ??
            zones.find((z) => z.name.toLowerCase().includes(r) || r.includes(z.name.toLowerCase()));
        if (found) return found;
    }
    if (zones.length === 1 || (!ref && zones.length)) return zones[0]!;
    throw new AgentError(
        zones.length
            ? `no watch zone matches "${ref}"; known: ${zones.map((z) => z.name).join(', ')}`
            : 'there are no watch zones yet',
    );
}

export async function geography(ctx: Ctx, zoneId: string): Promise<Geography> {
    const g = await ctx.api.geography(zoneId);
    return { roads: g.roads, civilianAreas: g.civilianAreas, safeZones: g.safeZones };
}

const POLL_MS = 1_000;

/**
 * Enqueues a planner job and waits for it. The planner computes; the agent only asks and reads.
 * Resolves with the view when the job succeeds, rejects when it fails or the wait runs out.
 */
export async function runPlanner(
    ctx: Ctx,
    zoneId: string,
    request: {
        reason: string;
        incidentId?: string | null;
        options?: PlannerOptions;
        requestedBy?: string;
    },
): Promise<PlannerJobView> {
    const job = await ctx.api.enqueuePlan(zoneId, {
        requestedBy: request.requestedBy ?? EMBER,
        reason: request.reason,
        ...(request.incidentId ? { incidentId: request.incidentId } : {}),
        ...(request.options ? { options: request.options } : {}),
    });
    return waitForPlan(ctx, job.jobId);
}

export async function waitForPlan(ctx: Ctx, jobId: string): Promise<PlannerJobView> {
    const deadline = ctx.now().getTime() + ctx.config.plannerWaitMs;
    for (;;) {
        const view = await ctx.api.plan(jobId);
        if (view.job.state === 'succeeded' && view.result) return view;
        if (view.job.state === 'failed') {
            throw new AgentError(
                `planner job ${jobId} failed: ${view.job.message ?? 'no reason given'}`,
            );
        }
        if (ctx.now().getTime() >= deadline) {
            throw new AgentError(
                `planner job ${jobId} is still ${view.job.state} after ${Math.round(ctx.config.plannerWaitMs / 1000)} s; is the planner running?`,
            );
        }
        await ctx.sleep(POLL_MS);
    }
}

export function describeError(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : String(err);
}
