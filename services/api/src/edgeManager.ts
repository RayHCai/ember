import { EDGE_SERVERS_PATH, EDGE_TASK_PATH } from '@ember/contracts';
import type { EdgeServerStatus, EdgeTask, EdgeTaskResult } from '@ember/contracts';

/** edge-manager over HTTP (`edge.ts`). */
export type EdgeManager = {
    /** The live registry by edge server id, cached briefly; null while edge-manager is unreachable. */
    live(): Promise<Map<string, EdgeServerStatus> | null>;
    /** Throws `EdgeManagerError` when edge-manager cannot be reached or refuses the task. */
    task(task: EdgeTask): Promise<EdgeTaskResult>;
};

export class EdgeManagerError extends Error {
    override name = 'EdgeManagerError';
}

export type EdgeManagerOptions = {
    url: string;
    /** `EMBER_EDGE_KEY`. */
    key?: string;
    fetch?: typeof fetch;
    cacheMs?: number;
    liveTimeoutMs?: number;
    taskTimeoutMs?: number;
    now?: () => number;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function errorOf(body: string): string {
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) return String(parsed.error);
    } catch {
        // Not JSON: the body is the message.
    }
    return body.slice(0, 500);
}

export function createEdgeManager({
    url,
    key,
    fetch: doFetch = fetch,
    cacheMs = 2_000,
    liveTimeoutMs = 1_500,
    taskTimeoutMs = 20_000,
    now = Date.now,
}: EdgeManagerOptions): EdgeManager {
    const base = url.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    let cached: { at: number; value: Promise<Map<string, EdgeServerStatus> | null> } | null = null;

    // Live status is decoration on records the api owns, so an unreachable edge-manager is null.
    async function fetchLive() {
        try {
            const res = await doFetch(`${base}${EDGE_SERVERS_PATH}`, {
                headers,
                signal: AbortSignal.timeout(liveTimeoutMs),
            });
            if (!res.ok) return null;
            const list: unknown = await res.json();
            if (!Array.isArray(list)) return null;
            return new Map((list as EdgeServerStatus[]).map((s) => [s.edgeServerId, s]));
        } catch {
            return null;
        }
    }

    return {
        live() {
            const at = now();
            if (!cached || at - cached.at >= cacheMs) cached = { at, value: fetchLive() };
            return cached.value;
        },
        async task(task) {
            let res: Response;
            try {
                res = await doFetch(`${base}${EDGE_TASK_PATH}`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(task),
                    signal: AbortSignal.timeout(taskTimeoutMs),
                });
            } catch (err) {
                throw new EdgeManagerError(`edge-manager at ${base}: ${message(err)}`);
            }
            const body = await res.text();
            if (!res.ok) {
                throw new EdgeManagerError(`edge-manager answered ${res.status}: ${errorOf(body)}`);
            }
            let result: unknown;
            try {
                result = JSON.parse(body);
            } catch {
                throw new EdgeManagerError(`edge-manager answered ${task.kind} with no JSON`);
            }
            if (
                !result ||
                typeof result !== 'object' ||
                !('results' in result) ||
                !Array.isArray(result.results)
            ) {
                throw new EdgeManagerError(`edge-manager answered ${task.kind} without results`);
            }
            return result as EdgeTaskResult;
        },
    };
}
