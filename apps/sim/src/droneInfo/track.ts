import type {
    CameraSpec,
    DroneDetections,
    DroneInfoMessage,
    DronePose,
    DroneSummary,
    DroneTelemetry,
} from '@ember/contracts';

type Sample = { at: number; telemetry: DroneTelemetry };

/** Rendering a little in the past lets poses interpolate between 10 Hz telemetry messages. */
const RENDER_DELAY_MS = 150;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpAngle(a: number, b: number, t: number): number {
    const d = ((((b - a) % 360) + 540) % 360) - 180;
    return (((a + d * t) % 360) + 360) % 360;
}

export function interpolatePose(a: DronePose, b: DronePose, t: number): DronePose {
    return {
        lat: lerp(a.lat, b.lat, t),
        lng: lerp(a.lng, b.lng, t),
        altM: lerp(a.altM, b.altM, t),
        headingDeg: lerpAngle(a.headingDeg, b.headingDeg, t),
        pitchDeg: lerp(a.pitchDeg, b.pitchDeg, t),
    };
}

/**
 * What Drone Info has reported: the fleet, and for the followed drone its smoothed pose,
 * scenario clock and latest detections.
 */
export class DroneTrack {
    fleet: DroneSummary[] = [];
    followed: string | null = null;
    detections: DroneDetections | null = null;
    detectionsAt = 0;
    lastMessageAt = 0;
    private samples: Sample[] = [];
    private clock: { timeMs: number; speed: number; at: number } | null = null;

    follow(droneId: string | null): void {
        this.followed = droneId;
        this.detections = null;
        this.detectionsAt = 0;
        this.samples = [];
        this.clock = null;
    }

    ingest(msg: DroneInfoMessage, now: number): void {
        if (msg.type === 'fleet') {
            this.fleet = msg.drones;
            return;
        }
        if (msg.droneId !== this.followed) return;
        this.lastMessageAt = now;
        if (msg.type === 'telemetry') {
            this.samples.push({ at: now, telemetry: msg });
            if (this.samples.length > 30) this.samples.shift();
            if (msg.scenarioTime) {
                const t = Date.parse(msg.scenarioTime);
                if (Number.isFinite(t))
                    this.clock = { timeMs: t, speed: msg.scenarioSpeed, at: now };
            }
        } else {
            this.detections = msg;
            this.detectionsAt = now;
        }
    }

    get telemetry(): DroneTelemetry | null {
        return this.samples.at(-1)?.telemetry ?? null;
    }

    get camera(): CameraSpec | null {
        return this.telemetry?.camera ?? this.detections?.camera ?? null;
    }

    poseAt(now: number): DronePose | null {
        const s = this.samples;
        if (s.length === 0) return null;
        const t = now - RENDER_DELAY_MS;
        if (s.length === 1 || t >= s.at(-1)!.at) return s.at(-1)!.telemetry.pose;
        for (let i = s.length - 1; i > 0; i--) {
            const a = s[i - 1]!;
            const b = s[i]!;
            if (t >= a.at) {
                return interpolatePose(
                    a.telemetry.pose,
                    b.telemetry.pose,
                    (t - a.at) / Math.max(1, b.at - a.at),
                );
            }
        }
        return s[0]!.telemetry.pose;
    }

    /** Scenario time (epoch ms) the drone's sensors follow, extrapolated to `now`. */
    scenarioTimeAt(now: number): number | null {
        const c = this.clock;
        return c ? c.timeMs + (now - c.at) * c.speed : null;
    }
}
