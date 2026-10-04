import type { z } from 'zod';
import type { ChatTurn } from '../memory.js';

export type ToolSpec = {
    name: string;
    description: string;
    /** JSON schema of the arguments object. */
    parameters: Record<string, unknown>;
};

/** Runs one tool and returns what the model sees: always JSON-safe. */
export type ToolRun = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type ConverseRequest = {
    system: string;
    history: ChatTurn[];
    text: string;
    tools: ToolSpec[];
    run: ToolRun;
    maxSteps?: number;
};

/**
 * The language layer: picks and sequences tools for a request, and writes. It never produces a
 * number or a geometry the agent acts on: tools fetch those from the api and planner.
 */
export interface Reasoner {
    readonly name: string;
    converse(req: ConverseRequest): Promise<{ text: string }>;
    /** A JSON answer validated against `schema`; throws when the model cannot produce one. */
    structured<T>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T>;
}

export class ReasonerUnavailable extends Error {}
