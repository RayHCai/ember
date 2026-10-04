import {
    EDGE_SERVERS_PATH,
    EDGE_TASK_PATH,
    PLANNER_QUEUE_KEY,
    type EdgeServerStatus,
    type EdgeTask,
    type EdgeTaskResult,
    type PlannerJobRequest,
} from '@ember/contracts';
import { Redis } from 'ioredis';

export interface PlannerQueue {
    enqueue(job: PlannerJobRequest): Promise<void>;
    close(): Promise<void>;
}

export class RedisPlannerQueue implements PlannerQueue {
    private readonly redis: Redis;

    constructor(url: string) {
        this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    }

    async enqueue(job: PlannerJobRequest) {
        await this.redis.lpush(PLANNER_QUEUE_KEY, JSON.stringify(job));
    }

    async close() {
        this.redis.disconnect();
    }
}

export class MemoryPlannerQueue implements PlannerQueue {
    readonly jobs: PlannerJobRequest[] = [];

    async enqueue(job: PlannerJobRequest) {
        this.jobs.push(job);
    }

    async close() {}
}

export interface EdgeManager {
    send(task: EdgeTask): Promise<EdgeTaskResult>;
    servers(): Promise<EdgeServerStatus[]>;
}

export type Fetch = typeof fetch;

async function reach(url: string, init: RequestInit, fetchImpl: Fetch): Promise<Response> {
    try {
        return await fetchImpl(url, init);
    } catch (err) {
        const cause = (err as { cause?: { code?: string } }).cause?.code;
        throw new Error(
            `edge-manager unreachable at ${new URL(url).origin}${cause ? ` (${cause})` : ''}`,
            { cause: err },
        );
    }
}

export class HttpEdgeManager implements EdgeManager {
    constructor(
        private readonly baseUrl: string,
        private readonly key: string | undefined,
        private readonly fetchImpl: Fetch = fetch,
    ) {}

    private headers() {
        return {
            'content-type': 'application/json',
            ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        };
    }

    async send(task: EdgeTask) {
        const res = await reach(
            `${this.baseUrl}${EDGE_TASK_PATH}`,
            {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(task),
                signal: AbortSignal.timeout(15_000),
            },
            this.fetchImpl,
        );
        if (!res.ok) {
            throw new Error(`edge-manager ${EDGE_TASK_PATH}: ${res.status} ${await res.text()}`);
        }
        return (await res.json()) as EdgeTaskResult;
    }

    async servers() {
        const res = await reach(
            `${this.baseUrl}${EDGE_SERVERS_PATH}`,
            { headers: this.headers(), signal: AbortSignal.timeout(5_000) },
            this.fetchImpl,
        );
        if (!res.ok) throw new Error(`edge-manager ${EDGE_SERVERS_PATH}: ${res.status}`);
        return (await res.json()) as EdgeServerStatus[];
    }
}
