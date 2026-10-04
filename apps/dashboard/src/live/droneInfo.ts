import { DRONE_INFO_STREAM_PATH } from '@ember/contracts';
import type { DroneDetections, DroneInfoMessage, DroneInfoViewerMessage } from '@ember/contracts';
import { useEffect } from 'react';
import { create } from 'zustand';
import { config } from '../config';
import { fromFleet, fromTelemetry } from './telemetry';

// One WebSocket to drone-info while signed in: the fleet snapshot every second, and every report
// from the drones of the zone on screen (`watch`).

/** Detections frames older than this leave the live overlay; the api's risk zones hold them. */
const LIVE_DETECTIONS_MS = 45_000;
const RETRY_MS = [500, 1000, 2000, 4000, 8000];

interface LinkState {
    connected: boolean;
    /** Bumped on every detections frame, so layers redraw. */
    detectionsVersion: number;
}

export const useDroneInfo = create<LinkState>()(() => ({ connected: false, detectionsVersion: 0 }));

let socket: WebSocket | null = null;
let watched: string[] = [];
let retries = 0;
let retryTimer = 0;
let running = false;
// Aged by arrival: a drone's clock need not match this machine's.
const frames: { frame: DroneDetections; at: number }[] = [];
const frameListeners = new Set<(frame: DroneDetections) => void>();

function send(m: DroneInfoViewerMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
}

function onMessage(raw: string): void {
    let m: DroneInfoMessage;
    try {
        m = JSON.parse(raw) as DroneInfoMessage;
    } catch {
        return;
    }
    if (m.type === 'fleet') fromFleet(m.drones);
    else if (m.type === 'telemetry') fromTelemetry(m);
    else if (m.type === 'detections') {
        const now = Date.now();
        frames.push({ frame: m, at: now });
        while (frames.length && frames[0]!.at < now - LIVE_DETECTIONS_MS) frames.shift();
        if (frames.length > 400) frames.splice(0, frames.length - 400);
        useDroneInfo.setState((s) => ({ detectionsVersion: s.detectionsVersion + 1 }));
        for (const fn of frameListeners) fn(m);
    }
}

function open(): void {
    if (!running) return;
    const ws = new WebSocket(config.droneInfoUrl + DRONE_INFO_STREAM_PATH);
    socket = ws;
    ws.onopen = () => {
        retries = 0;
        useDroneInfo.setState({ connected: true });
        if (watched.length) send({ type: 'watch', droneIds: watched });
    };
    ws.onmessage = (e) => {
        if (typeof e.data === 'string') onMessage(e.data);
    };
    ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        useDroneInfo.setState({ connected: false });
        if (!running) return;
        retryTimer = window.setTimeout(open, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
    };
}

/** Opens the stream; the returned function closes it. */
export function connectDroneInfo(): () => void {
    if (running) return () => {};
    running = true;
    open();
    return () => {
        running = false;
        window.clearTimeout(retryTimer);
        const ws = socket;
        socket = null;
        ws?.close();
        useDroneInfo.setState({ connected: false });
    };
}

/** Streams every report of these drones; replaces the previous list. */
export function watchDrones(droneIds: string[]): void {
    const next = [...new Set(droneIds)].sort();
    if (next.join('\n') === watched.join('\n')) return;
    watched = next;
    send({ type: 'watch', droneIds: watched });
}

/** Detections frames from the last moments, oldest first. */
export function liveDetections(): readonly DroneDetections[] {
    const cutoff = Date.now() - LIVE_DETECTIONS_MS;
    return frames.filter((f) => f.at >= cutoff).map((f) => f.frame);
}

export function onDetections(fn: (frame: DroneDetections) => void): () => void {
    frameListeners.add(fn);
    return () => frameListeners.delete(fn);
}

/** Watches these drones while the calling page is mounted. */
export function useWatchedDrones(droneIds: string[]): void {
    const key = [...droneIds].sort().join(',');
    useEffect(() => {
        watchDrones(key ? key.split(',') : []);
        return () => watchDrones([]);
    }, [key]);
}
