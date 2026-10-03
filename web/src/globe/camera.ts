import {
  BoundingSphere,
  Cartesian3,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  type Viewer,
} from "cesium";
import type { LatLon } from "../types/events";

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface FlyOptions {
  /** Distance from the target in meters. */
  range?: number;
  pitchDeg?: number;
  headingDeg?: number;
  /** Seconds. Forced to 0 when the user prefers reduced motion. */
  duration?: number;
  heightM?: number;
}

let stopActiveOrbit: (() => void) | null = null;

/** Stop the slow orbit, if one is running (any new camera move does this). */
export function stopOrbit(): void {
  stopActiveOrbit?.();
}

const ORBIT_RAD_PER_FRAME = 0.0018;

/** Slow orbit around a point until stopped, a new flight starts, or the operator touches the map. */
export function startOrbit(viewer: Viewer, lat: number, lon: number): () => void {
  stopOrbit();
  const center = Cartesian3.fromDegrees(lon, lat, 0);
  let heading = viewer.camera.heading;
  const pitch = viewer.camera.pitch;
  const range = Cartesian3.distance(viewer.camera.positionWC, center);
  const canvas = viewer.scene.canvas;
  let stopped = false;
  const removeFrame = viewer.scene.preRender.addEventListener(() => {
    heading += ORBIT_RAD_PER_FRAME;
    viewer.camera.lookAt(center, new HeadingPitchRange(heading, pitch, range));
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeFrame();
    canvas.removeEventListener("pointerdown", stop);
    canvas.removeEventListener("wheel", stop);
    if (!viewer.isDestroyed()) viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    if (stopActiveOrbit === stop) stopActiveOrbit = null;
  };
  canvas.addEventListener("pointerdown", stop);
  canvas.addEventListener("wheel", stop, { passive: true });
  stopActiveOrbit = stop;
  return stop;
}

/** Fly to an oblique view looking at a point. Resolves when the flight ends. */
export function flyToPoint(viewer: Viewer, lat: number, lon: number, opts: FlyOptions = {}): Promise<void> {
  const { range = 9000, pitchDeg = -35, headingDeg = 0, duration = 3, heightM = 0 } = opts;
  stopOrbit();
  const sphere = new BoundingSphere(Cartesian3.fromDegrees(lon, lat, heightM), 1);
  return new Promise((resolve) => {
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(
        CesiumMath.toRadians(headingDeg),
        CesiumMath.toRadians(pitchDeg),
        range,
      ),
      duration: prefersReducedMotion() ? 0 : duration,
      complete: () => resolve(),
      cancel: () => resolve(),
    });
  });
}

/** Fly so a set of points fills the view, at an oblique angle. */
export function flyToPoints(viewer: Viewer, points: LatLon[], opts: FlyOptions = {}): Promise<void> {
  const sphere = BoundingSphere.fromPoints(points.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat)));
  const center = sphere.center;
  const carto = viewer.scene.ellipsoid.cartesianToCartographic(center);
  return flyToPoint(viewer, CesiumMath.toDegrees(carto.latitude), CesiumMath.toDegrees(carto.longitude), {
    range: Math.max(sphere.radius * 3, 2500),
    ...opts,
  });
}

export function centroid(points: LatLon[]): LatLon {
  const n = points.length || 1;
  const lat = points.reduce((sum, p) => sum + p[0], 0) / n;
  const lon = points.reduce((sum, p) => sum + p[1], 0) / n;
  return [lat, lon];
}

/** Whole-earth view centered over a point. */
export function setWholeEarthView(viewer: Viewer, lat: number, lon: number): void {
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, 22_000_000) });
}
