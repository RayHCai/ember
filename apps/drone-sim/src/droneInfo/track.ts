import type {
    CameraSpec,
    DroneDetections,
    DroneInfoMessage,
    DronePose,
    DroneSummary,
    DroneTelemetry,
} from '@ember/contracts';

/** `sent` is the drone's `sentAt` (epoch ms on the drone's clock). */
type Sample = { sent: number; telemetry: DroneTelemetry };

/**
 * How far behind the drone's own clock poses are drawn: three 10 Hz telemetry messages, so one
 * late hop still finds the next message already here.
 */
export const RENDER_DELAY_MS = 300;
/** Past the newest message the pose carries on along its velocity this long, then holds. */
const EXTRAPOLATE_MAX_MS = 1000;
/** Lets the drone-to-viewer offset grow back by this much per message if latency rises for good. */
const OFFSET_CREEP_MS = 1;
/** Past-path points: one per metre or so, about 10 minutes of flight at survey speed. */
const TRAIL_MAX = 6000;
const TRAIL_STEP_M = 1;
const M_PER_DEG_LAT = 110_740;
const M_PER_DEG_LNG = 111_320;

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

function extrapolate(m: DroneTelemetry, dtS: number): DronePose {
    const { pose, velocity: v } = m;
    return {
        ...pose,
        lat: pose.lat + (v.northMps * dtS) / M_PER_DEG_LAT,
        lng: pose.lng + (v.eastMps * dtS) / (M_PER_DEG_LNG * Math.cos((pose.lat * Math.PI) / 180)),
        altM: pose.altM + v.upMps * dtS,
    };
}

/**
 * What Drone Info has reported: the fleet, and for the followed drone its smoothed pose,
 * scenario clock and latest detections.
 *
 * Poses are placed by the drone's `sentAt`, not by when they arrived: every hop between drone and
 * viewer batches and delays messages unevenly, and arrival spacing would show that as the drone
 * lurching. The offset between the two clocks is the smallest latency seen, so clock skew cancels.
 */
export class DroneTrack {
    fleet: DroneSummary[] = [];
    followed: string | null = null;
    detections: DroneDetections | null = null;
    detectionsAt = 0;
    lastMessageAt = 0;
    private samples: Sample[] = [];
    private trail: { sent: number; pose: DronePose }[] = [];
    private clock: { timeMs: number; speed: number; at: number } | null = null;
    private offset = Infinity;

    follow(droneId: string | null): void {
        this.followed = droneId;
        this.detections = null;
        this.detectionsAt = 0;
        this.samples = [];
        this.trail = [];
        this.clock = null;
        this.offset = Infinity;
    }

    ingest(msg: DroneInfoMessage, now: number): void {
        if (msg.type === 'fleet') {
            this.fleet = msg.drones;
            return;
        }
        if (msg.droneId !== this.followed) return;
        this.lastMessageAt = now;
        if (msg.type === 'telemetry') {
            const parsed = Date.parse(msg.sentAt);
            const sent = Number.isFinite(parsed) ? parsed : now;
            const last = this.samples.at(-1);
            if (last && sent <= last.sent) return;
            this.offset = Math.min(this.offset + OFFSET_CREEP_MS, now - sent);
            this.samples.push({ sent, telemetry: msg });
            if (this.samples.length > 30) this.samples.shift();
            this.record(sent, msg.pose);
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

    /** The drone's clock time drawn at viewer time `now`. */
    private renderTime(now: number): number {
        return now - RENDER_DELAY_MS - this.offset;
    }

    poseAt(now: number): DronePose | null {
        const s = this.samples;
        const last = s.at(-1);
        if (!last) return null;
        const t = this.renderTime(now);
        if (t >= last.sent) {
            return extrapolate(last.telemetry, Math.min(t - last.sent, EXTRAPOLATE_MAX_MS) / 1000);
        }
        for (let i = s.length - 1; i > 0; i--) {
            const a = s[i - 1]!;
            const b = s[i]!;
            if (t >= a.sent) {
                return interpolatePose(
                    a.telemetry.pose,
                    b.telemetry.pose,
                    (t - a.sent) / (b.sent - a.sent),
                );
            }
        }
        return s[0]!.telemetry.pose;
    }

    /** Where the followed drone has been, oldest first, up to the pose shown at `now`. */
    trailAt(now: number): DronePose[] {
        const t = this.renderTime(now);
        const out: DronePose[] = [];
        for (const p of this.trail) {
            if (p.sent > t) break;
            out.push(p.pose);
        }
        return out;
    }

    private record(sent: number, pose: DronePose): void {
        const last = this.trail.at(-1)?.pose;
        if (last) {
            const north = (pose.lat - last.lat) * M_PER_DEG_LAT;
            const east =
                (pose.lng - last.lng) * M_PER_DEG_LNG * Math.cos((pose.lat * Math.PI) / 180);
            if (Math.hypot(north, east, pose.altM - last.altM) < TRAIL_STEP_M) return;
        }
        this.trail.push({ sent, pose });
        if (this.trail.length > TRAIL_MAX) this.trail.shift();
    }

    /** Scenario time (epoch ms) the drone's sensors follow, extrapolated to `now`. */
    scenarioTimeAt(now: number): number | null {
        const c = this.clock;
        return c ? c.timeMs + (now - c.at) * c.speed : null;
    }
}
