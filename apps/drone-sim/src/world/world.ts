import type { Scene, Vector3 } from 'three';
import type { WorldAssets } from './assets';
import { Buildings } from './buildings';
import { FireField } from './fireField';
import { Flames } from './flames';
import { Smoke } from './smoke';
import { Ground } from './ground';
import { Sky } from './sky';
import { Vegetation } from './vegetation';
import type { Models } from './models';

/** The reconstructed world at one scenario moment: ground, roads, trees, buildings, fire and light. */
export class World {
    readonly fire: FireField;
    readonly vegetation: Vegetation;
    private readonly sky: Sky;
    private readonly ground: Ground;
    private readonly buildings: Buildings;
    private readonly flames: Flames;
    private readonly smoke: Smoke;
    private fireMinute = Number.NaN;
    private fireWallS = -1;

    constructor(
        scene: Scene,
        readonly assets: WorldAssets,
        models: Models,
    ) {
        this.fire = new FireField(assets.fire);
        this.sky = new Sky(scene, assets.frame);
        this.ground = new Ground(scene, assets, this.fire, models.ground);
        this.vegetation = new Vegetation(scene, assets, models.trees);
        this.buildings = new Buildings(scene, assets.buildings, assets.roads, models.buildings);
        this.flames = new Flames(scene, this.fire, models.flames);
        this.smoke = new Smoke(scene, this.fire, assets.windFromDeg, models.smoke);
    }

    minuteAt(timeMs: number): number {
        return (timeMs - this.assets.rekindleMs) / 60_000;
    }

    /** `timeMs`: scenario time (epoch ms). `drone`: the followed drone, kept clear of smoke. */
    update(
        timeMs: number,
        dt: number,
        wallS: number,
        camera: Vector3,
        drone: Vector3 | null,
    ): void {
        const minute = this.minuteAt(timeMs);
        let fireChanged = false;
        if (
            Number.isNaN(this.fireMinute) ||
            (Math.abs(minute - this.fireMinute) >= 0.05 && wallS - this.fireWallS >= 0.25)
        ) {
            this.fire.update(minute);
            this.flames.rebuild();
            this.fireMinute = minute;
            this.fireWallS = wallS;
            fireChanged = true;
        }
        const smokiness = Math.min(1, this.fire.totalIntensity / 1500);
        this.sky.update(timeMs, camera, smokiness);
        const L = this.sky.lighting;
        this.ground.update(L, wallS, fireChanged);
        this.vegetation.update(minute, wallS, camera);
        this.buildings.update(minute, wallS, camera);
        this.flames.update(wallS);
        this.smoke.update(dt, wallS, L.dark, drone);
    }
}
