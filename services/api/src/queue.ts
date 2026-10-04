import { createClient } from 'redis';
import { PLANNER_QUEUE_KEY } from '@ember/contracts';
import type { PlannerJobRequest } from '@ember/contracts';

export type PlannerQueue = {
    push(job: PlannerJobRequest): Promise<void>;
    close(): Promise<void>;
};

/**
 * The planner orchestrator's Redis list. Connects in the background and fails pushes while Redis is
 * down rather than queueing them in memory, so a job is never reported queued when it is not.
 */
export function redisPlannerQueue(url: string, onError: (err: unknown) => void): PlannerQueue {
    const client = createClient({ url, disableOfflineQueue: true });
    client.on('error', onError);
    client.connect().catch(onError);
    return {
        async push(job) {
            await client.lPush(PLANNER_QUEUE_KEY, JSON.stringify(job));
        },
        async close() {
            if (client.isOpen) await client.close();
        },
    };
}
