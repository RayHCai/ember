import {
    BufferGeometry,
    Float32BufferAttribute,
    Group,
    Line,
    LineBasicMaterial,
    LineDashedMaterial,
} from 'three';
import type { Scene } from 'three';
import type { DronePose, DroneTelemetry } from '@ember/contracts';
import { toLocal, toScene } from '../world/frame';
import type { WorldFrame } from '../world/frame';
import { LAYER } from '../world/visibility';

const PAST_COLOUR = 0x1f5fbf;
const FUTURE_COLOUR = 0x5b9bf0;
const FUTURE_OPACITY = 0.55;
/** How far ahead the reported velocity is projected. */
export const FUTURE_HORIZON_S = 20;
const FUTURE_STEPS = 8;

/** Swaps the geometry rather than its attribute, so the old GPU buffer is freed. */
function setPoints(line: Line, xyz: number[]): void {
    line.geometry.dispose();
    line.geometry = new BufferGeometry();
    line.geometry.setAttribute('position', new Float32BufferAttribute(xyz, 3));
}

/**
 * Where the followed drone has been (dashed) and where its current velocity takes it (solid,
 * translucent). Drone Info reports no planned route, so the future is a straight projection.
 */
export class DronePath {
    readonly group = new Group();
    private readonly past: Line;
    private readonly future: Line;

    constructor(scene: Scene) {
        this.past = new Line(
            new BufferGeometry(),
            new LineDashedMaterial({ color: PAST_COLOUR, dashSize: 3, gapSize: 2 }),
        );
        this.future = new Line(
            new BufferGeometry(),
            new LineBasicMaterial({
                color: FUTURE_COLOUR,
                transparent: true,
                opacity: FUTURE_OPACITY,
                depthWrite: false,
            }),
        );
        for (const o of [this.past, this.future]) {
            o.frustumCulled = false;
            o.layers.set(LAYER.DRONE);
            this.group.add(o);
        }
        this.group.visible = false;
        scene.add(this.group);
    }

    update(
        frame: WorldFrame,
        pose: DronePose,
        trail: readonly DronePose[],
        velocity: DroneTelemetry['velocity'] | null,
    ): void {
        this.group.visible = true;
        const here = toLocal(frame, pose.lat, pose.lng);

        const past = [...trail, pose].flatMap((p) => {
            const { x, y } = toLocal(frame, p.lat, p.lng);
            return toScene(x, y, p.altM).toArray();
        });
        setPoints(this.past, past);
        this.past.computeLineDistances();

        const future: number[] = [];
        if (velocity && Math.hypot(velocity.eastMps, velocity.northMps, velocity.upMps) > 0.05) {
            for (let i = 0; i <= FUTURE_STEPS; i++) {
                const t = (FUTURE_HORIZON_S * i) / FUTURE_STEPS;
                const alt = Math.max(0, pose.altM + velocity.upMps * t);
                future.push(
                    ...toScene(
                        here.x + velocity.eastMps * t,
                        here.y + velocity.northMps * t,
                        alt,
                    ).toArray(),
                );
            }
        }
        setPoints(this.future, future);
    }

    hide(): void {
        this.group.visible = false;
    }
}
