import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { ConverseRequest, Reasoner } from './reasoner.js';

const MAX_STEPS = 10;
const MAX_TOKENS = 8000;

type Messages = Pick<Anthropic['messages'], 'create' | 'parse'>;

/** Claude for every language task: tool sequencing, parsing, drafting, explaining. */
export class ClaudeReasoner implements Reasoner {
    readonly name: string;
    private readonly messages: Messages;

    constructor(
        private readonly model: string,
        messages?: Messages,
    ) {
        this.name = `claude:${model}`;
        this.messages = messages ?? new Anthropic().messages;
    }

    async converse(req: ConverseRequest) {
        const tools: Anthropic.Tool[] = req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));
        // A conversation must open with the user; trimmed history can start mid-exchange.
        const first = req.history.findIndex((t) => t.role === 'user');
        const history = first < 0 ? [] : req.history.slice(first);
        const messages: Anthropic.MessageParam[] = [
            ...history.map((t): Anthropic.MessageParam => ({
                role: t.role === 'user' ? 'user' : 'assistant',
                content: t.text,
            })),
            { role: 'user', content: req.text },
        ];
        for (let step = 0; step < (req.maxSteps ?? MAX_STEPS); step++) {
            const res = await this.messages.create({
                model: this.model,
                max_tokens: MAX_TOKENS,
                // The system prompt and tool list are the same every turn, so they cache.
                system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
                ...(tools.length ? { tools } : {}),
                messages,
            });
            if (res.stop_reason === 'refusal') throw new Error('claude declined the request');
            const text = res.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
                .trim();
            const calls = res.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );
            if (res.stop_reason !== 'tool_use' || !calls.length) return { text };
            messages.push({ role: 'assistant', content: res.content });
            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const call of calls) {
                let result: unknown;
                let failed = false;
                try {
                    result = await req.run(call.name, call.input as Record<string, unknown>);
                    failed = !!(result as { error?: unknown } | null)?.error;
                } catch (err) {
                    result = { error: err instanceof Error ? err.message : String(err) };
                    failed = true;
                }
                results.push({
                    type: 'tool_result',
                    tool_use_id: call.id,
                    content: JSON.stringify(result),
                    ...(failed ? { is_error: true } : {}),
                });
            }
            messages.push({ role: 'user', content: results });
        }
        throw new Error(`claude: no answer after ${req.maxSteps ?? MAX_STEPS} tool steps`);
    }

    async structured<T>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T> {
        const res = await this.messages.parse({
            model: this.model,
            max_tokens: MAX_TOKENS,
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
            output_config: { format: zodOutputFormat(req.schema) },
        });
        if (res.stop_reason === 'refusal') throw new Error('claude declined the request');
        if (res.parsed_output == null) throw new Error('claude: no structured answer');
        // The helper parsed it already; parse again so the agent's own schema is the gate.
        return req.schema.parse(res.parsed_output);
    }
}
