import type { FastifyInstance } from 'fastify';
import { DRONE_INFO_STREAM_PATH } from '@ember/contracts';
import type { DroneInfoMessage } from '@ember/contracts';
import type { Fleet } from '../fleet.js';

/** `{type: 'follow', droneId}` from a viewer, or null if it is anything else. */
function followOf(raw: string): { droneId: string | null } | null {
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof v !== 'object' || v === null) return null;
    const m = v as { type?: unknown; droneId?: unknown };
    if (m.type !== 'follow') return null;
    if (m.droneId !== null && typeof m.droneId !== 'string') return null;
    return { droneId: m.droneId };
}

/** The fleet on connect and every `fleetIntervalMs`; the followed drone's updates as they arrive. */
export function streamRoutes(app: FastifyInstance, fleet: Fleet, fleetIntervalMs: number) {
    app.get(DRONE_INFO_STREAM_PATH, { websocket: true }, (socket, req) => {
        let following: string | null = null;
        const send = (m: DroneInfoMessage) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
        };
        send(fleet.snapshot());
        const timer = setInterval(() => send(fleet.snapshot()), fleetIntervalMs);
        const off = fleet.subscribe((u) => {
            if (u.droneId === following) send(u);
        });
        socket.on('message', (data: Buffer) => {
            const follow = followOf(data.toString());
            if (!follow) {
                req.log.warn('stream: ignored a message that is not a follow');
                return;
            }
            following = follow.droneId;
            if (following) for (const m of fleet.latest(following)) send(m);
        });
        socket.on('close', () => {
            clearInterval(timer);
            off();
        });
    });
}
