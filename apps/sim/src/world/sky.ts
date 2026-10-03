import { Color, DirectionalLight, HemisphereLight, Vector3 } from 'three';
import type { Scene } from 'three';
import type { WorldFrame } from './frame';
import { daylight, sunPosition } from './sun';

export type Lighting = {
    /** Unit vector toward the sun, scene axes. */
    sunDir: Vector3;
    sunColor: Color;
    ambient: Color;
    /** 1 at night, 0 in full daylight. */
    dark: number;
    elevationDeg: number;
};

const srgb = (r: number, g: number, b: number): Color => new Color().setRGB(r, g, b, 'srgb');

/** Sun and sky light for a scenario moment, following Demo Data's lighting (sunset ~19:05 HST). */
export class Sky {
    readonly lighting: Lighting = {
        sunDir: new Vector3(0, 1, 0),
        sunColor: new Color(1, 1, 1),
        ambient: new Color(0.3, 0.3, 0.3),
        dark: 0,
        elevationDeg: 90,
    };
    private readonly sun = new DirectionalLight(0xffffff, 2.5);
    private readonly hemi = new HemisphereLight(0xbfd4ff, 0x4a4033, 1.0);

    constructor(
        scene: Scene,
        private readonly frame: WorldFrame,
    ) {
        scene.add(this.sun, this.sun.target, this.hemi);
    }

    /** `smokiness` 0..1 dims the sun while the town burns. */
    update(timeMs: number, cameraPosition: Vector3, smokiness: number): void {
        const { elevationDeg, azimuthDeg } = sunPosition(this.frame.lat0, this.frame.lng0, timeMs);
        const light = daylight(elevationDeg);
        const el = (Math.max(elevationDeg, -4) * Math.PI) / 180;
        const az = (azimuthDeg * Math.PI) / 180;
        const dir = new Vector3(
            Math.sin(az) * Math.cos(el),
            Math.sin(el),
            -Math.cos(az) * Math.cos(el),
        ).normalize();

        let tint: [number, number, number] = [1, 1, 1];
        if (elevationDeg < -6) tint = [0.72, 0.84, 1.15];
        else if (elevationDeg < 8) {
            const w = (elevationDeg + 6) / 14;
            tint = [0.9 * (1 - w) + 1.08 * w, 0.85 * (1 - w) + 0.93 * w, 1.0 * (1 - w) + 0.8 * w];
        }
        const s = Math.min(Math.max(smokiness, 0), 1);
        const L = this.lighting;
        L.sunDir.copy(dir);
        L.elevationDeg = elevationDeg;
        L.dark = 1 - light;
        const sunUp = Math.max(0, Math.min(1, (elevationDeg + 2) / 8));
        L.sunColor
            .copy(srgb(tint[0], tint[1], tint[2]))
            .multiplyScalar(2.2 * light * sunUp * (1 - 0.45 * s));
        L.ambient
            .copy(srgb(0.55 * tint[0], 0.6 * tint[1], 0.7 * tint[2]))
            .multiplyScalar(0.55 * light + 0.04);

        this.sun.position.copy(dir).multiplyScalar(5000).add(cameraPosition);
        this.sun.target.position.copy(cameraPosition);
        this.sun.color.copy(L.sunColor);
        this.sun.intensity = 1.4;
        this.hemi.color.copy(L.ambient);
        this.hemi.groundColor.copy(L.ambient).multiplyScalar(0.5);
        this.hemi.intensity = 2.0;
    }
}
