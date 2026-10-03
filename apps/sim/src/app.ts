import {
    MOUSE,
    NoToneMapping,
    PerspectiveCamera,
    Scene,
    SRGBColorSpace,
    Vector3,
    WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DroneInfoClient } from './droneInfo/client';
import { DummyDroneInfo } from './droneInfo/dummy';
import type { DroneInfoSource } from './droneInfo/source';
import { DroneTrack } from './droneInfo/track';
import type { Launch } from './launch';
import { warn } from './log';
import { applyDronePose } from './view/droneCamera';
import { DroneMarker } from './view/marker';
import { loadWorld } from './world/assets';
import { loadModels } from './world/models';
import { toLocal, toScene } from './world/frame';
import { DroneSight } from './world/visibility';
import { World } from './world/world';

const STALE_LINK_MS = 4000;
const START_BACK_M = 45;
const START_UP_M = 22;
const FOCUS_RANGE_M: [number, number] = [12, 150];

/**
 * The sim: one drone, fixed for the life of the process, shown as a model in the Demo Data scenario. What its camera
 * sees is rebuilt in 3D; everything else is white. Dragging orbits the view around the drone.
 * It moves nothing and detects nothing itself.
 */
export class App {
    private readonly renderer: WebGLRenderer;
    private readonly scene = new Scene();
    private readonly camera = new PerspectiveCamera(50, 1, 0.5, 30000);
    private readonly controls: OrbitControls;
    private readonly sight = new DroneSight();
    private readonly track = new DroneTrack();
    private readonly source: DroneInfoSource;
    private world: World | null = null;
    private marker: DroneMarker | null = null;
    private dronePosition: Vector3 | null = null;
    private droneId: string | null = null;
    private loading: string | null = 'Loading world…';
    private failure: string | null = null;
    private lastFrameTime = performance.now();
    private lastStatusAt = 0;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly status: HTMLElement,
        private readonly launch: Launch,
    ) {
        this.renderer = new WebGLRenderer({ canvas, antialias: true });
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.toneMapping = NoToneMapping;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.autoClear = false;
        this.renderer.setClearColor(0xffffff);
        this.camera.layers.enableAll();

        // Unity scene view: drag to orbit, middle or right drag to pan, wheel to zoom, F to refocus.
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.12;
        this.controls.screenSpacePanning = true;
        this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
        this.controls.minDistance = 4;
        this.controls.maxDistance = 3000;
        this.controls.maxPolarAngle = Math.PI * 0.495;
        window.addEventListener('keydown', (ev) => {
            if (ev.key === 'f' || ev.key === 'F') this.focus();
        });

        this.source = launch.droneInfoUrl
            ? new DroneInfoClient(launch.droneInfoUrl)
            : new DummyDroneInfo(launch.demoDataUrl);
        this.source.onMessage((m) => {
            // Without a drone from the launch settings, show the first one the fleet reports.
            if (!this.droneId && m.type === 'fleet' && m.drones[0]) this.show(m.drones[0].droneId);
            this.track.ingest(m, Date.now());
        });
        if (launch.droneId) this.show(launch.droneId);
    }

    private show(droneId: string): void {
        this.droneId = droneId;
        this.track.follow(droneId);
        this.source.follow(droneId);
        document.title = `Ember Drone Sim · ${droneId}`;
    }

    async start(): Promise<void> {
        this.source.start();
        requestAnimationFrame(this.loop);
        try {
            const [assets, models] = await Promise.all([
                loadWorld(this.launch.demoDataUrl, (step, done, total) => {
                    this.loading = `${step}… ${Math.round((done / total) * 100)}%`;
                }),
                loadModels(),
            ]);
            this.loading = 'Building scene…';
            await new Promise((r) => setTimeout(r, 0));
            this.world = new World(this.scene, assets, models);
            this.marker = new DroneMarker(this.scene, models.drone);
            this.loading = null;
        } catch (err) {
            warn('world unavailable', err);
            this.failure = `${String(err)}\n\nIs Demo Data running at ${this.launch.demoDataUrl}?\n  cd services/demo-data && uv run demo-data serve`;
        }
    }

    /** Back to the drone, at a comfortable range, keeping the viewing angle. */
    private focus(): void {
        if (!this.dronePosition) return;
        const offset = this.camera.position.clone().sub(this.controls.target);
        offset.setLength(Math.min(Math.max(offset.length(), FOCUS_RANGE_M[0]), FOCUS_RANGE_M[1]));
        this.controls.target.copy(this.dronePosition);
        this.camera.position.copy(this.dronePosition).add(offset);
    }

    /** Carries the view along with the drone, keeping whatever orbit and pan the user set. */
    private followDrone(position: Vector3, headingDeg: number): void {
        if (this.dronePosition) {
            const delta = position.clone().sub(this.dronePosition);
            this.camera.position.add(delta);
            this.controls.target.add(delta);
        } else {
            const h = (headingDeg * Math.PI) / 180;
            this.controls.target.copy(position);
            this.camera.position
                .copy(position)
                .add(
                    new Vector3(
                        -Math.sin(h) * START_BACK_M,
                        START_UP_M,
                        Math.cos(h) * START_BACK_M,
                    ),
                );
        }
        this.dronePosition = position;
    }

    private statusText(wall: number, hasPose: boolean): string | null {
        const id = this.droneId;
        if (this.failure) return this.failure;
        if (this.loading) return this.loading;
        if (!id) return 'Waiting for the fleet…';
        const s = this.source.status;
        if (s.status !== 'open')
            return `Connecting to ${s.label}…${s.detail ? `\n${s.detail}` : ''}`;
        if (!hasPose) {
            const fleet = this.track.fleet;
            if (fleet.length && !fleet.some((d) => d.droneId === id))
                return `${id} is not in the fleet (${fleet.map((d) => d.droneId).join(', ')}).\nRestart the sim and pick one of those.`;
            return `Waiting for ${id}…`;
        }
        const quiet = wall - this.track.lastMessageAt;
        return quiet > STALE_LINK_MS
            ? `No data from ${id} for ${Math.round(quiet / 1000)} s`
            : null;
    }

    private readonly loop = (): void => {
        requestAnimationFrame(this.loop);
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
        this.lastFrameTime = now;
        const wall = Date.now();
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w === 0 || h === 0) return;
        const r = this.renderer;
        r.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();

        const pose = this.track.poseAt(wall);
        const spec = this.track.camera;
        if (now - this.lastStatusAt > 200) {
            this.lastStatusAt = now;
            const text = this.statusText(wall, pose !== null);
            this.status.textContent = text ?? '';
            this.status.hidden = text === null;
        }

        r.setRenderTarget(null);
        r.clear();
        const world = this.world;
        if (!world) return;
        const frame = world.assets.frame;
        if (pose && spec) {
            const { x, y } = toLocal(frame, pose.lat, pose.lng);
            this.followDrone(toScene(x, y, pose.altM), pose.headingDeg);
            applyDronePose(this.sight.camera, frame, pose, spec);
        }
        this.controls.update();

        const scenarioMs = this.track.scenarioTimeAt(wall) ?? world.assets.rekindleMs;
        world.update(scenarioMs, dt, now / 1000, this.camera.position);
        if (pose && spec) {
            this.sight.render(r, this.scene);
            this.marker?.update(
                frame,
                pose,
                spec,
                this.track.detections,
                wall - this.track.detectionsAt,
            );
        } else {
            this.sight.blind();
        }
        r.render(this.scene, this.camera);
    };
}
