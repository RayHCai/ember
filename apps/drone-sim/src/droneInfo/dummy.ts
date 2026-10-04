import type {
    DroneDetections,
    DroneSummary,
    DroneTelemetry,
    RiskDetection,
} from '@ember/contracts';
import { warn } from '../log';
import { DUMMY_CAMERA, DUMMY_DRONE } from './dummyDrone';
import type { DroneInfoSource, SourceStatus } from './source';
import { Emitter } from './source';

const TELEMETRY_MS = 100;
const FLEET_MS = 1000;
const DETECTIONS_MS = 2500;
const CLOCK_MS = 5000;
const THERMAL_WIDTH = 320;
const FLAME_K = 600;

const DEG = Math.PI / 180;
const metres = (lat: number) => ({ mLat: 110_740, mLng: 111_320 * Math.cos(lat * DEG) });

type Hotspot = {
    lat: number;
    lon: number;
    max_temp_k: number;
    area_m2: number;
    bbox_px: [number, number, number, number];
};

/** Demo Data's thermal hotspots for a frame, as the on-fire detections a drone would report. */
export function hotspotDetections(hotspots: Hotspot[], frameId: number): RiskDetection[] {
    const scale = DUMMY_CAMERA.widthPx / THERMAL_WIDTH;
    return hotspots
        .filter((h) => h.max_temp_k >= FLAME_K)
        .map((h, i) => {
            const half = Math.max(5, Math.sqrt(h.area_m2)) / 2;
            const { mLat, mLng } = metres(h.lat);
            const dLat = half / mLat;
            const dLng = half / mLng;
            const [x0, y0, x1, y1] = h.bbox_px;
            return {
                id: `${frameId}-${i}`,
                risk: 'on_fire',
                confidence: 1,
                bboxPx: [x0 * scale, y0 * scale, x1 * scale, y1 * scale],
                ground: [
                    { lat: h.lat + dLat, lng: h.lon - dLng },
                    { lat: h.lat + dLat, lng: h.lon + dLng },
                    { lat: h.lat - dLat, lng: h.lon + dLng },
                    { lat: h.lat - dLat, lng: h.lon - dLng },
                ],
                center: { lat: h.lat, lng: h.lon },
                areaM2: h.area_m2,
                peakTempK: h.max_temp_k,
            };
        });
}

/**
 * Stand-in for services/drone-info when the sim has no `--drone-info`: one drone hovering at a
 * fixed pose, reporting as its detections the thermal hotspots Demo Data serves a camera there. No
 * flight model and no detector run here.
 */
export class DummyDroneInfo implements DroneInfoSource {
    private readonly emitter = new Emitter({
        status: 'open',
        label: 'Dummy drone data',
        detail: null,
    });
    private readonly timers: ReturnType<typeof setInterval>[] = [];
    private readonly started = Date.now();
    private following: string | null = null;
    private frameId = 0;
    private detecting = false;
    private clock: { timeMs: number; speed: number; paused: boolean; at: number } | null = null;

    constructor(private readonly demoDataUrl: string) {}

    get status(): SourceStatus {
        return this.emitter.status;
    }

    onMessage = (fn: Parameters<Emitter['onMessage']>[0]) => this.emitter.onMessage(fn);
    onStatus = (fn: Parameters<Emitter['onStatus']>[0]) => this.emitter.onStatus(fn);

    start(): void {
        void this.syncClock();
        this.emitFleet();
        this.timers.push(
            setInterval(() => this.emitFleet(), FLEET_MS),
            setInterval(() => this.emitTelemetry(), TELEMETRY_MS),
            setInterval(() => void this.emitDetections(), DETECTIONS_MS),
            setInterval(() => void this.syncClock(), CLOCK_MS),
        );
    }

    stop(): void {
        for (const t of this.timers) clearInterval(t);
        this.timers.length = 0;
    }

    follow(droneId: string | null): void {
        this.following = droneId;
        void this.emitDetections();
    }

    private seconds(): number {
        return (Date.now() - this.started) / 1000;
    }

    private scenarioTime(): string | null {
        const c = this.clock;
        if (!c) return null;
        const ms = c.timeMs + (c.paused ? 0 : (Date.now() - c.at) * c.speed);
        return new Date(ms).toISOString();
    }

    private async syncClock(): Promise<void> {
        try {
            const c = (await (await fetch(`${this.demoDataUrl}/v1/clock`)).json()) as {
                scenario_time: string;
                speed: number;
                paused: boolean;
            };
            this.clock = {
                timeMs: Date.parse(c.scenario_time),
                speed: c.speed,
                paused: c.paused,
                at: Date.now(),
            };
        } catch {
            // Demo Data down: telemetry carries no scenario time until it is back.
        }
    }

    private emitFleet(): void {
        const t = this.seconds();
        const drones: DroneSummary[] = [
            {
                ...DUMMY_DRONE,
                mode: 'idle',
                batteryPct: 100 - ((t / 30) % 80),
                lastSeen: new Date().toISOString(),
            },
        ];
        this.emitter.message({ type: 'fleet', drones });
    }

    private emitTelemetry(): void {
        if (this.following !== DUMMY_DRONE.droneId) return;
        const message: DroneTelemetry = {
            type: 'telemetry',
            droneId: DUMMY_DRONE.droneId,
            sentAt: new Date().toISOString(),
            scenarioTime: this.scenarioTime(),
            scenarioSpeed: this.clock && !this.clock.paused ? this.clock.speed : 0,
            pose: DUMMY_DRONE.pose,
            camera: DUMMY_CAMERA,
            velocity: { eastMps: 0, northMps: 0, upMps: 0 },
            batteryPct: 100 - ((this.seconds() / 30) % 80),
            mode: 'idle',
        };
        this.emitter.message(message);
    }

    private async emitDetections(): Promise<void> {
        if (this.following !== DUMMY_DRONE.droneId || this.detecting) return;
        this.detecting = true;
        const { pose, droneId } = DUMMY_DRONE;
        const q = new URLSearchParams({
            lat: String(pose.lat),
            lon: String(pose.lng),
            alt_m: String(pose.altM),
            heading_deg: String(pose.headingDeg),
            pitch_deg: String(pose.pitchDeg),
            width: String(DUMMY_CAMERA.widthPx),
            height: String(DUMMY_CAMERA.heightPx),
            hfov_deg: String(DUMMY_CAMERA.hfovDeg),
            thermal_width: String(THERMAL_WIDTH),
            images: '',
        });
        try {
            const res = await fetch(`${this.demoDataUrl}/v1/observation?${q}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const obs = (await res.json()) as { scenario_time: string; hotspots: Hotspot[] };
            if (droneId !== this.following) return;
            const frameId = ++this.frameId;
            const message: DroneDetections = {
                type: 'detections',
                droneId,
                frameId,
                capturedAt: new Date().toISOString(),
                scenarioTime: obs.scenario_time,
                pose,
                camera: DUMMY_CAMERA,
                detector: 'demo-data hotspots (dummy)',
                detections: hotspotDetections(obs.hotspots, frameId),
            };
            this.emitter.message(message);
        } catch (err) {
            warn('dummy drone info: no observation from Demo Data', err);
        } finally {
            this.detecting = false;
        }
    }
}
