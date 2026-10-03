import { Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { CameraSpec, DronePose } from '@ember/contracts';
import { enuToScene, toLocal, toScene } from '../world/frame';
import type { WorldFrame } from '../world/frame';

const DEG = Math.PI / 180;

export function verticalFovDeg(cam: CameraSpec): number {
    const fx = cam.widthPx / 2 / Math.tan((cam.hfovDeg * DEG) / 2);
    return (2 * Math.atan(cam.heightPx / 2 / fx)) / DEG;
}

/**
 * Forward, right and image-down unit vectors in east/north/up, the convention Demo Data and
 * drone-runtime use (heading 0 = north, pitch -90 = nadir with image top toward heading).
 */
export function cameraBasis(
    headingDeg: number,
    pitchDeg: number,
): { fwd: Vector3; right: Vector3; down: Vector3 } {
    const h = headingDeg * DEG;
    const p = pitchDeg * DEG;
    const fwd = new Vector3(Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p));
    const right = new Vector3(Math.cos(h), -Math.sin(h), 0);
    const down = new Vector3().crossVectors(fwd, right);
    return { fwd, right, down };
}

/** Puts a Three.js camera exactly where the drone's camera is, with the same field of view. */
export function applyDronePose(
    camera: PerspectiveCamera,
    frame: WorldFrame,
    pose: DronePose,
    spec: CameraSpec,
): void {
    const { x, y } = toLocal(frame, pose.lat, pose.lng);
    camera.position.copy(toScene(x, y, pose.altM));
    const { fwd, right, down } = cameraBasis(pose.headingDeg, pose.pitchDeg);
    const xAxis = enuToScene(right.x, right.y, right.z);
    const yAxis = enuToScene(-down.x, -down.y, -down.z);
    const zAxis = enuToScene(-fwd.x, -fwd.y, -fwd.z);
    camera.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis));
    camera.fov = verticalFovDeg(spec);
    camera.aspect = spec.widthPx / spec.heightPx;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
}
