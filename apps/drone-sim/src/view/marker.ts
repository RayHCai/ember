import {
    BufferGeometry,
    DoubleSide,
    Float32BufferAttribute,
    Group,
    LineBasicMaterial,
    LineLoop,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    ShapeUtils,
    Vector2,
} from 'three';
import type { Material, Object3D, Scene } from 'three';
import type {
    CameraSpec,
    DroneDetections,
    DronePose,
    LatLng,
    RiskDetection,
} from '@ember/contracts';
import { toLocal, toScene } from '../world/frame';
import type { WorldFrame } from '../world/frame';
import { LAYER } from '../world/visibility';
import { cameraBasis } from './droneCamera';

/** Readme colours: yellow for at-risk, red for current fire. */
export const RISK_COLOUR: Record<RiskDetection['risk'], string> = {
    on_fire: '#ff3b30',
    at_risk: '#ffcc00',
};

const ZONE_OPACITY = 0.3;

/** Detections disappear once their frame is this old. */
export const DETECTION_TTL_MS = 6000;

const MAX_RANGE_M = 4000;
/** Larger than life (the airframe is 0.9 m across) so the drone reads from the orbit distance. */
const MODEL_SCALE = 6;
const PROPELLERS = ['front_left', 'front_right', 'rear_left', 'rear_right'];

/** Ground point (world x, y) of an ENU ray from the drone, clipped like the drone's footprint. */
function groundHit(
    ox: number,
    oy: number,
    alt: number,
    e: number,
    n: number,
    u: number,
): [number, number] {
    if (u < -1e-9) {
        const s = -alt / u;
        let dx = e * s;
        let dy = n * s;
        const d = Math.hypot(dx, dy);
        if (d > MAX_RANGE_M) {
            dx *= MAX_RANGE_M / d;
            dy *= MAX_RANGE_M / d;
        }
        return [ox + dx, oy + dy];
    }
    const h = Math.hypot(e, n) || 1;
    return [ox + (e / h) * MAX_RANGE_M, oy + (n / h) * MAX_RANGE_M];
}

function onDroneLayer(o: Object3D): void {
    o.traverse((c) => c.layers.set(LAYER.DRONE));
}

/**
 * The followed drone in the scene: its model, its camera's frustum and ground footprint, and the
 * ground outline of each risk it reported. None of it is ever darkened or seen by the drone itself.
 */
export class DroneMarker {
    readonly group = new Group();
    private readonly model: Object3D;
    private readonly gimbal: Object3D | null;
    private readonly frustum: LineSegments;
    private readonly footprint: LineLoop;
    private readonly detections = new Group();
    private shownFrameId = -1;

    /** `drone`: the `assets/` quadcopter (front towards +Z). */
    constructor(scene: Scene, drone: Object3D) {
        this.model = drone;
        this.model.scale.setScalar(MODEL_SCALE);
        this.gimbal = drone.getObjectByName('gimbal') ?? null;
        // In flight the blur discs stand in for the spinning blades (assets/README.md).
        for (const name of PROPELLERS) {
            const blades = drone.getObjectByName(`propeller_${name}`);
            if (blades) blades.visible = false;
        }
        const line = new LineBasicMaterial({ color: 0x1f5fbf, transparent: true, opacity: 0.7 });
        this.frustum = new LineSegments(new BufferGeometry(), line);
        this.footprint = new LineLoop(new BufferGeometry(), line);
        for (const o of [this.frustum, this.footprint]) o.frustumCulled = false;
        this.group.add(this.model, this.frustum, this.footprint, this.detections);
        this.group.visible = false;
        onDroneLayer(this.group);
        scene.add(this.group);
    }

    update(
        frame: WorldFrame,
        pose: DronePose,
        spec: CameraSpec,
        report: DroneDetections | null,
        reportAgeMs: number,
    ): void {
        this.group.visible = true;
        const { x, y } = toLocal(frame, pose.lat, pose.lng);
        toScene(x, y, pose.altM, this.model.position);
        // Rotating +Z (the model's front) by pi - heading points it along the heading.
        this.model.rotation.y = Math.PI - (pose.headingDeg * Math.PI) / 180;
        if (this.gimbal) this.gimbal.rotation.x = (-pose.pitchDeg * Math.PI) / 180;

        const { fwd, right, down } = cameraBasis(pose.headingDeg, pose.pitchDeg);
        const fx = spec.widthPx / 2 / Math.tan((spec.hfovDeg * Math.PI) / 360);
        const corners = [
            [0, 0],
            [spec.widthPx, 0],
            [spec.widthPx, spec.heightPx],
            [0, spec.heightPx],
        ].map(([u, v]) => {
            const a = (u! - spec.widthPx / 2) / fx;
            const b = (v! - spec.heightPx / 2) / fx;
            const e = fwd.x + a * right.x + b * down.x;
            const n = fwd.y + a * right.y + b * down.y;
            const z = fwd.z + a * right.z + b * down.z;
            return groundHit(x, y, pose.altM, e, n, z);
        });
        const rays = corners.flatMap(([gx, gy]) => [x, pose.altM, -y, gx, 0.5, -gy]);
        this.frustum.geometry.setAttribute('position', new Float32BufferAttribute(rays, 3));
        this.footprint.geometry.setAttribute(
            'position',
            new Float32BufferAttribute(
                corners.flatMap(([gx, gy]) => [gx, 0.5, -gy]),
                3,
            ),
        );

        this.detections.visible = report !== null && reportAgeMs < DETECTION_TTL_MS;
        if (report && report.frameId !== this.shownFrameId) {
            this.shownFrameId = report.frameId;
            this.detections.traverse((o) => {
                if (o instanceof Mesh || o instanceof LineLoop) {
                    (o.geometry as BufferGeometry).dispose();
                    (o.material as Material).dispose();
                }
            });
            this.detections.clear();
            // Fire last, so red zones sit on top of the larger yellow exposure zones.
            const ordered = report.detections.toSorted((a, b) =>
                a.risk === b.risk ? 0 : a.risk === 'at_risk' ? -1 : 1,
            );
            ordered.forEach((det, i) =>
                this.detections.add(this.zone(frame, det.ground, RISK_COLOUR[det.risk], i)),
            );
            onDroneLayer(this.detections);
        }
    }

    /** The readme's coloured overlay zone: a translucent fill with a solid edge. */
    private zone(frame: WorldFrame, ground: LatLng[], colour: string, order: number): Group {
        const flat = ground.map((p) => {
            const { x, y } = toLocal(frame, p.lat, p.lng);
            return new Vector2(x, y);
        });
        const pts = flat.flatMap((v) => [v.x, 1.0, -v.y]);

        const fill = new BufferGeometry();
        fill.setAttribute('position', new Float32BufferAttribute(pts, 3));
        fill.setIndex(ShapeUtils.triangulateShape(flat, []).flat());
        const area = new Mesh(
            fill,
            new MeshBasicMaterial({
                color: colour,
                transparent: true,
                opacity: ZONE_OPACITY,
                side: DoubleSide,
                depthTest: false,
                depthWrite: false,
            }),
        );

        const edge = new BufferGeometry();
        edge.setAttribute('position', new Float32BufferAttribute(pts, 3));
        const line = new LineLoop(edge, new LineBasicMaterial({ color: colour, depthTest: false }));

        const zone = new Group();
        area.renderOrder = 5 + 2 * order;
        line.renderOrder = 6 + 2 * order;
        for (const o of [area, line]) {
            o.frustumCulled = false;
            zone.add(o);
        }
        return zone;
    }
}
