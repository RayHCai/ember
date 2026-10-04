import { Cartesian3, EasingFunction, Math as CesiumMath, Rectangle, type Viewer } from 'cesium';
import type { LatLon } from '../sim/types';

// The map is always looked at from straight above.

const TOP_DOWN = { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 };

export function prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface Framing {
    /** Share of the view to keep clear on each side for floating panels, 0 to 1. */
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
}

/** A rectangle around the points that leaves room for the panels. */
export function framedRectangle(points: LatLon[], frame: Framing = {}): Rectangle {
    const { left = 0.12, right = 0.12, top = 0.14, bottom = 0.14 } = frame;
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const w = Math.max(east - west, 0.004);
    const h = Math.max(north - south, 0.004);
    const usableW = Math.max(0.2, 1 - left - right);
    const usableH = Math.max(0.2, 1 - top - bottom);
    const totalW = w / usableW;
    const totalH = h / usableH;
    return Rectangle.fromDegrees(
        west - totalW * left,
        south - totalH * bottom,
        east + totalW * right,
        north + totalH * top,
    );
}

/** Flies to a set of points from straight above. Resolves when the flight ends. */
export function flyToPoints(
    viewer: Viewer,
    points: LatLon[],
    opts: { frame?: Framing; duration?: number; dive?: boolean } = {},
): Promise<void> {
    if (points.length === 0) return Promise.resolve();
    const destination = framedRectangle(points, opts.frame);
    const reduced = prefersReducedMotion();
    if (opts.dive && !reduced) {
        // Start high over the target so the arrival reads as a dive, not a slide.
        const center = Rectangle.center(destination);
        viewer.camera.setView({
            destination: Cartesian3.fromRadians(center.longitude, center.latitude, 260_000),
            orientation: TOP_DOWN,
        });
    }
    return new Promise((resolve) => {
        viewer.camera.flyTo({
            destination,
            orientation: TOP_DOWN,
            duration: reduced ? 0 : (opts.duration ?? 1.6),
            easingFunction: EasingFunction.QUINTIC_IN_OUT,
            complete: () => resolve(),
            cancel: () => resolve(),
        });
    });
}

export function flyToPoint(
    viewer: Viewer,
    [lat, lon]: LatLon,
    heightM = 14_000,
    duration = 1.6,
): Promise<void> {
    return new Promise((resolve) => {
        viewer.camera.flyTo({
            destination: Cartesian3.fromDegrees(lon, lat, heightM),
            orientation: TOP_DOWN,
            duration: prefersReducedMotion() ? 0 : duration,
            easingFunction: EasingFunction.QUINTIC_IN_OUT,
            complete: () => resolve(),
            cancel: () => resolve(),
        });
    });
}

export function setOverview(viewer: Viewer, [lat, lon]: LatLon): void {
    viewer.camera.setView({
        destination: Cartesian3.fromDegrees(lon, lat, 9_000_000),
        orientation: TOP_DOWN,
    });
}
