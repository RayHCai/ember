import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroneInfoMessage, DroneTelemetry } from '@ember/contracts';
import type { SocketLike } from './client';
import { DroneInfoClient, streamUrl } from './client';
import { hotspotDetections } from './dummy';
import { DUMMY_DRONE } from './dummyDrone';
import { parseDroneInfoMessage } from './messages';
import { DroneTrack, interpolatePose } from './track';

const pose = { lat: 20.87, lng: -156.67, altM: 150, headingDeg: 350, pitchDeg: -50 };
const camera = { widthPx: 480, heightPx: 360, hfovDeg: 84 };
const telemetry: DroneTelemetry = {
    type: 'telemetry',
    droneId: 'd1',
    sentAt: '',
    scenarioTime: '2023-08-08T16:30:00-10:00',
    scenarioSpeed: 60,
    pose,
    camera,
    velocity: { eastMps: 0, northMps: 0, upMps: 0 },
    batteryPct: 90,
    mode: 'patrol',
};

class FakeSocket implements SocketLike {
    sent: string[] = [];
    closed = false;
    private listeners = new Map<string, ((ev: never) => void)[]>();

    addEventListener(type: string, fn: (ev: never) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
    }

    fire(type: 'open' | 'message' | 'close', ev: unknown = {}): void {
        for (const fn of this.listeners.get(type) ?? []) fn(ev as never);
    }
}

describe('parseDroneInfoMessage', () => {
    it('accepts contract telemetry and rejects telemetry without a camera', () => {
        expect('message' in parseDroneInfoMessage(JSON.stringify(telemetry))).toBe(true);
        const { camera: _, ...noCamera } = telemetry;
        expect(parseDroneInfoMessage(JSON.stringify(noCamera))).toEqual({
            error: 'telemetry: bad pose or camera',
        });
        expect(parseDroneInfoMessage('nope')).toEqual({ error: 'not JSON' });
    });
});

describe('DroneInfoClient', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('follows one drone and re-sends the follow after reconnecting', () => {
        const sockets: FakeSocket[] = [];
        const client = new DroneInfoClient('localhost:8200', () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        });
        const got: DroneInfoMessage[] = [];
        client.onMessage((m) => got.push(m));
        client.start();
        sockets[0]!.fire('open');
        client.follow('d1');
        expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ type: 'follow', droneId: 'd1' });
        sockets[0]!.fire('message', { data: JSON.stringify(telemetry) });
        expect(got).toHaveLength(1);
        sockets[0]!.fire('close', { code: 1006, reason: '' });
        vi.advanceTimersByTime(1000);
        sockets[1]!.fire('open');
        expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'follow', droneId: 'd1' });
    });

    it('builds the stream URL', () => {
        expect(streamUrl('http://localhost:8200')).toBe('ws://localhost:8200/v1/stream');
    });
});

describe('DroneTrack', () => {
    it('keeps only the followed drone and extrapolates its scenario clock', () => {
        const track = new DroneTrack();
        track.follow('d1');
        track.ingest({ ...telemetry, droneId: 'other' }, 500);
        expect(track.telemetry).toBeNull();
        track.ingest(telemetry, 1000);
        expect(track.camera).toEqual(camera);
        expect(track.scenarioTimeAt(2000)).toBe(Date.parse('2023-08-08T16:31:00-10:00'));
    });

    it('interpolates headings the short way round', () => {
        expect(interpolatePose(pose, { ...pose, headingDeg: 10 }, 0.5).headingDeg).toBeCloseTo(
            0,
            6,
        );
    });
});

describe('dummy Drone Info', () => {
    it('hovers inside Demo Data coverage', () => {
        const p = DUMMY_DRONE.pose;
        expect(p.lat).toBeGreaterThan(20.838);
        expect(p.lat).toBeLessThan(20.915);
        expect(p.lng).toBeGreaterThan(-156.695);
        expect(p.lng).toBeLessThan(-156.64);
    });

    it('turns flaming hotspots into on-fire detections in camera pixels', () => {
        const dets = hotspotDetections(
            [
                {
                    lat: 20.87,
                    lon: -156.67,
                    max_temp_k: 900,
                    area_m2: 100,
                    bbox_px: [10, 20, 30, 40],
                },
                { lat: 20.87, lon: -156.67, max_temp_k: 500, area_m2: 100, bbox_px: [0, 0, 5, 5] },
            ],
            3,
        );
        expect(dets).toHaveLength(1);
        expect(dets[0]).toMatchObject({ id: '3-0', risk: 'on_fire', bboxPx: [15, 30, 45, 60] });
        expect(dets[0]!.ground).toHaveLength(4);
    });
});
