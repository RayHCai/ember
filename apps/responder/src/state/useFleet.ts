import { useEffect, useState } from 'react';
import { DRONE_INFO_STREAM_PATH, type DroneInfoMessage, type DroneSummary } from '@ember/contracts';

const NONE: DroneSummary[] = [];

/** Live drone positions from drone-info; empty when offline or the zone has no drone-info URL. */
export function useFleet(droneInfoUrl: string | null, enabled: boolean): DroneSummary[] {
    const [drones, setDrones] = useState<DroneSummary[]>(NONE);
    const live = !!droneInfoUrl && enabled;

    useEffect(() => {
        if (!droneInfoUrl || !enabled) return;
        const url = `${droneInfoUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}${DRONE_INFO_STREAM_PATH}`;
        let ws: WebSocket | null = null;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let closed = false;

        const onMessage = (e: MessageEvent) => {
            try {
                const msg = JSON.parse(String(e.data)) as DroneInfoMessage;
                if (msg.type === 'fleet') setDrones(msg.drones);
            } catch {
                // Frames that are not JSON are not ours to show.
            }
        };
        const onClose = () => {
            if (!closed) retry = setTimeout(open, 5_000);
        };
        function open() {
            ws = new WebSocket(url);
            ws.addEventListener('message', onMessage);
            ws.addEventListener('close', onClose);
        }
        open();
        return () => {
            closed = true;
            clearTimeout(retry);
            ws?.close();
        };
    }, [droneInfoUrl, enabled]);

    return live ? drones : NONE;
}
