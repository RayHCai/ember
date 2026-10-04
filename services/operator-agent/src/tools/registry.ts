import type { AgentCard } from '@ember/contracts';
import { z } from 'zod';
import { describeError, type Ctx } from '../context.js';
import type { ToolSpec } from '../llm/reasoner.js';

/** Who is asking, and what this turn has produced so far. */
export type Turn = {
    actor: string;
    operator: boolean;
    cards: AgentCard[];
    toolCalls: { name: string; ok: boolean }[];
    decisionIds: string[];
};

export type ToolResult = { summary: string; data?: unknown; cards?: AgentCard[] };

export type Tool<S extends z.ZodObject = z.ZodObject> = {
    name: string;
    description: string;
    args: S;
    /** Changes state: only operators may call it. */
    acts: boolean;
    run(ctx: Ctx, args: z.infer<S>, turn: Turn): Promise<ToolResult>;
};

export function tool<S extends z.ZodObject>(t: Tool<S>): Tool {
    return t as unknown as Tool;
}

export function specs(tools: Tool[], operator: boolean): ToolSpec[] {
    return tools
        .filter((t) => operator || !t.acts)
        .map((t) => {
            const { $schema: _, ...parameters } = z.toJSONSchema(t.args) as Record<string, unknown>;
            return { name: t.name, description: t.description, parameters };
        });
}

/** Validates, runs, and records one call; errors come back as data the model can read. */
export async function invoke(
    ctx: Ctx,
    tools: Tool[],
    turn: Turn,
    name: string,
    raw: Record<string, unknown>,
): Promise<{ summary: string; data?: unknown; error?: string }> {
    const t = tools.find((x) => x.name === name);
    if (!t) return { summary: `unknown tool ${name}`, error: 'unknown tool' };
    if (t.acts && !turn.operator) {
        turn.toolCalls.push({ name, ok: false });
        return { summary: `${name} needs an Ember operator`, error: 'operator only' };
    }
    const parsed = t.args.safeParse(raw);
    if (!parsed.success) {
        turn.toolCalls.push({ name, ok: false });
        const issues = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        return { summary: `bad arguments for ${name}: ${issues}`, error: issues };
    }
    try {
        const out = await t.run(ctx, parsed.data, turn);
        turn.toolCalls.push({ name, ok: true });
        turn.cards.push(...(out.cards ?? []));
        return { summary: out.summary, data: out.data };
    } catch (err) {
        turn.toolCalls.push({ name, ok: false });
        const message = describeError(err);
        ctx.log.warn({ tool: name, err: message }, 'tool failed');
        return { summary: `${name} failed: ${message}`, error: message };
    }
}
