import { DETECTIONS_INGEST_PATH } from '@ember/contracts';
import type { DroneDetections } from '@ember/contracts';

export type ForwarderLogger = { warn: (obj: object, msg: string) => void };

export type ForwarderOptions = {
    apiUrl: string;
    key?: string;
    fetch?: typeof fetch;
    logger?: ForwarderLogger;
};

const MAX_QUEUE = 500;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/** Hands detection frames to the api in order, one request at a time, without blocking ingest. */
export class DetectionForwarder {
    private readonly queue: DroneDetections[] = [];
    private readonly url: string;
    private readonly fetchFn: typeof fetch;
    private readonly logger: ForwarderLogger;
    private timer: NodeJS.Timeout | undefined;
    private wake: (() => void) | undefined;
    private running = false;
    private closed = false;
    dropped = 0;

    constructor(private readonly options: ForwarderOptions) {
        this.url = `${options.apiUrl.replace(/\/+$/, '')}${DETECTIONS_INGEST_PATH}`;
        this.fetchFn = options.fetch ?? fetch;
        this.logger = options.logger ?? { warn: () => {} };
    }

    push(frame: DroneDetections): void {
        if (this.closed) return;
        this.queue.push(frame);
        while (this.queue.length > MAX_QUEUE) {
            this.queue.shift();
            this.dropped += 1;
        }
        if (!this.running) void this.pump();
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.timer);
        this.wake?.();
    }

    private async pump(): Promise<void> {
        this.running = true;
        let backoff = BACKOFF_START_MS;
        while (!this.closed && this.queue.length > 0) {
            const frame = this.queue[0]!;
            // Sequential by design: one request in flight.
            // oxlint-disable-next-line no-await-in-loop
            const outcome = await this.send(frame);
            if (outcome === 'retry') {
                // oxlint-disable-next-line no-await-in-loop
                await this.sleep(backoff);
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
                continue;
            }
            backoff = BACKOFF_START_MS;
            // Overflow may have shifted the frame out while it was in flight.
            if (this.queue[0] === frame) this.queue.shift();
        }
        this.running = false;
    }

    private async send(frame: DroneDetections): Promise<'done' | 'retry'> {
        try {
            const res = await this.fetchFn(this.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(this.options.key ? { authorization: `Bearer ${this.options.key}` } : {}),
                },
                body: JSON.stringify(frame),
            });
            if (res.status >= 500) {
                this.logger.warn({ status: res.status }, 'forward: api error, retrying');
                return 'retry';
            }
            if (res.status >= 400) {
                this.dropped += 1;
                this.logger.warn(
                    { status: res.status, droneId: frame.droneId, frameId: frame.frameId },
                    'forward: api rejected frame, dropped',
                );
            }
            return 'done';
        } catch (err) {
            this.logger.warn({ err }, 'forward: api unreachable, retrying');
            return 'retry';
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            this.wake = resolve;
            this.timer = setTimeout(resolve, ms);
        });
    }
}
