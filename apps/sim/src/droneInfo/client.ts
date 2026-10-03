import { DRONE_INFO_STREAM_PATH } from '@ember/contracts';
import type { FollowDrone } from '@ember/contracts';
import { warn } from '../log';
import { parseDroneInfoMessage } from './messages';
import type { DroneInfoSource, SourceStatus } from './source';
import { Emitter } from './source';

/** The subset of WebSocket the client uses, so tests can substitute a fake. */
export type SocketLike = {
    addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
    addEventListener(type: 'close', fn: (ev: { code: number; reason: string }) => void): void;
    addEventListener(type: 'open', fn: () => void): void;
    send(data: string): void;
    close(): void;
};

export type SocketFactory = (url: string) => SocketLike;

/** `host:port`, `http(s)://host:port` or a full URL, to drone-info's stream WebSocket URL. */
export function streamUrl(input: string): string {
    let s = input.trim();
    if (!/^[a-z]+:\/\//i.test(s)) s = `ws://${s}`;
    const u = new URL(s.replace(/^http/i, 'ws'));
    if (u.pathname === '/' || u.pathname === '') u.pathname = DRONE_INFO_STREAM_PATH;
    return u.toString();
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

/** Live drone data from services/drone-info; reconnects with backoff and re-sends `follow`. */
export class DroneInfoClient implements DroneInfoSource {
    private readonly url: string;
    private readonly emitter: Emitter;
    private socket: SocketLike | null = null;
    private generation = 0;
    private retries = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private following: FollowDrone = { type: 'follow', droneId: null };

    constructor(
        url: string,
        private readonly factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike,
    ) {
        this.url = streamUrl(url);
        this.emitter = new Emitter({
            status: 'connecting',
            label: `Drone Info ${this.url}`,
            detail: null,
        });
    }

    get status(): SourceStatus {
        return this.emitter.status;
    }

    onMessage = (fn: Parameters<Emitter['onMessage']>[0]) => this.emitter.onMessage(fn);
    onStatus = (fn: Parameters<Emitter['onStatus']>[0]) => this.emitter.onStatus(fn);

    start(): void {
        this.open('connecting');
    }

    stop(): void {
        this.generation++;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.socket?.close();
        this.socket = null;
    }

    follow(droneId: string | null): void {
        this.following = { type: 'follow', droneId };
        if (this.emitter.status.status === 'open')
            this.socket?.send(JSON.stringify(this.following));
    }

    private open(status: 'connecting' | 'reconnecting'): void {
        const gen = ++this.generation;
        this.setStatus(status, null);
        let socket: SocketLike;
        try {
            socket = this.factory(this.url);
        } catch (err) {
            this.scheduleRetry(gen, String(err));
            return;
        }
        this.socket = socket;
        // Events from a socket this client has moved on from (generation changed) are ignored.
        socket.addEventListener('open', () => {
            if (gen !== this.generation) return;
            this.retries = 0;
            socket.send(JSON.stringify(this.following));
            this.setStatus('open', null);
        });
        socket.addEventListener('message', (ev) => {
            if (gen !== this.generation || typeof ev.data !== 'string') return;
            const parsed = parseDroneInfoMessage(ev.data);
            if ('error' in parsed) warn(`drone-info: ignored message (${parsed.error})`);
            else this.emitter.message(parsed.message);
        });
        socket.addEventListener('close', (ev) => {
            if (gen !== this.generation) return;
            this.socket = null;
            this.scheduleRetry(gen, ev.reason || `closed (${ev.code})`);
        });
    }

    private scheduleRetry(gen: number, detail: string): void {
        const delay = BACKOFF_MS[Math.min(this.retries, BACKOFF_MS.length - 1)]!;
        this.retries += 1;
        this.setStatus('reconnecting', `${detail}; retrying in ${delay / 1000}s`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (gen === this.generation) this.open('reconnecting');
        }, delay);
    }

    private setStatus(status: SourceStatus['status'], detail: string | null): void {
        this.emitter.setStatus({ status, label: this.emitter.status.label, detail });
    }
}
