import type { FastifyInstance } from 'fastify';
import { DRONE_INFO_STREAM_PATH } from '@ember/contracts';
import type { DroneInfoMessage, DroneInfoViewerMessage } from '@ember/contracts';
import type { Fleet } from '../fleet.js';

const MAX_WATCHED = 500;

/** A `follow` or `watch` from a viewer, or null if it is anything else. */
function viewerMessage(raw: string): DroneInfoViewerMessage | null {
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof v !== 'object' || v === null) return null;
    const m = v as { type?: unknown; droneId?: unknown; droneIds?: unknown };
    if (m.type === 'follow') {
        if (m.droneId !== null && typeof m.droneId !== 'string') return null;
        return { type: 'follow', droneId: m.droneId };
    }
    if (m.type === 'watch') {
        if (!Array.isArray(m.droneIds) || m.droneIds.length > MAX_WATCHED) return null;
        if (!m.droneIds.every((id): id is string => typeof id === 'string')) return null;
        return { type: 'watch', droneIds: m.droneIds };
    }
    return null;
}

/**
 * The fleet on connect and every `fleetIntervalMs`; updates of the followed drone and the watched
 * ones as they arrive.
 */
export function streamRoutes(app: FastifyInstance, fleet: Fleet, fleetIntervalMs: number) {
    app.get(DRONE_INFO_STREAM_PATH, { websocket: true }, (socket, req) => {
        let following: string | null = null;
        let watching = new Set<string>();
        const send = (m: DroneInfoMessage) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
        };
        const latest = (droneIds: Iterable<string>) => {
            for (const id of droneIds) for (const m of fleet.latest(id)) send(m);
        };
        send(fleet.snapshot());
        const timer = setInterval(() => send(fleet.snapshot()), fleetIntervalMs);
        const off = fleet.subscribe((u) => {
            if (u.droneId === following || watching.has(u.droneId)) send(u);
        });
        socket.on('message', (data: Buffer) => {
            const m = viewerMessage(data.toString());
            if (!m) {
                req.log.warn('stream: ignored a message that is not a follow or a watch');
                return;
            }
            if (m.type === 'follow') {
                following = m.droneId;
                if (following && !watching.has(following)) latest([following]);
                return;
            }
            const added = m.droneIds.filter((id) => !watching.has(id) && id !== following);
            watching = new Set(m.droneIds);
            latest(added);
        });
        socket.on('close', () => {
            clearInterval(timer);
            off();
        });
    });
}
