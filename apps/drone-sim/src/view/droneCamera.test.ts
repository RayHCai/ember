import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { CameraSpec, DronePose } from '@ember/contracts';
import type { WorldFrame } from '../world/frame';
import { toLocal, toScene } from '../world/frame';
import { applyDronePose, verticalFovDeg } from './droneCamera';

// Demo Data's world frame (GET /v1/world).
const FRAME: WorldFrame = {
    lat0: 20.8765,
    lng0: -156.6675,
    mLat: 110715.44707873555,
    mLng: 104055.68052100403,
};
const CAM: CameraSpec = { widthPx: 640, heightPx: 480, hfovDeg: 84 };

function project(pose: DronePose, lat: number, lng: number): [number, number] {
    const camera = new PerspectiveCamera();
    applyDronePose(camera, FRAME, pose, CAM);
    const { x, y } = toLocal(FRAME, lat, lng);
    const v = toScene(x, y, 0, new Vector3()).project(camera);
    return [((v.x + 1) / 2) * CAM.widthPx, ((1 - v.y) / 2) * CAM.heightPx];
}

describe('applyDronePose', () => {
    it('uses the drone camera field of view', () => {
        expect(verticalFovDeg(CAM)).toBeCloseTo(68.0626, 3);
    });

    it('looks straight down at nadir, image top toward the heading', () => {
        const pose = { lat: 20.8725, lng: -156.6772, altM: 150, headingDeg: 0, pitchDeg: -90 };
        const [u, v] = project(pose, 20.8725, -156.6772);
        expect(u).toBeCloseTo(320, 1);
        expect(v).toBeCloseTo(240, 1);
        // Demo Data puts this ground point at the top-left pixel.
        const [u0, v0] = project(pose, 20.8734149, -156.6784979);
        expect(Math.abs(u0)).toBeLessThan(1.5);
        expect(Math.abs(v0)).toBeLessThan(1.5);
    });

    it.each([
        [0, 0, 20.88136, -156.6742215],
        [640, 480, 20.8781971, -156.6758552],
        [100.5, 300.5, 20.8797838, -156.6757809],
    ])('puts Demo Data pixel (%d, %d) of an oblique frame in the same place', (u, v, lat, lng) => {
        const pose = { lat: 20.879, lng: -156.676, altM: 120, headingDeg: 75, pitchDeg: -60 };
        const [pu, pv] = project(pose, lat, lng);
        expect(Math.hypot(pu - u, pv - v)).toBeLessThan(1.5);
    });
});
