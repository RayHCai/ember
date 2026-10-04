import { Vector3 } from 'three';

/**
 * Demo Data's world frame: x metres east and y metres north of an origin, by linear scaling at
 * the origin latitude. Drone poses go through the same formula, so they line up with the
 * reconstructed trees, buildings and fire exactly.
 */
export type WorldFrame = { lat0: number; lng0: number; mLat: number; mLng: number };

export type Extent = { minX: number; minY: number; maxX: number; maxY: number };

export function toLocal(frame: WorldFrame, lat: number, lng: number): { x: number; y: number } {
    return { x: (lng - frame.lng0) * frame.mLng, y: (lat - frame.lat0) * frame.mLat };
}

export function toLatLng(frame: WorldFrame, x: number, y: number): { lat: number; lng: number } {
    return { lat: frame.lat0 + y / frame.mLat, lng: frame.lng0 + x / frame.mLng };
}

/** World (x east, y north, h up) to Three.js (X east, Y up, Z south). */
export function toScene(x: number, y: number, h = 0, out = new Vector3()): Vector3 {
    return out.set(x, h, -y);
}

/** East/north/up vector to Three.js axes. */
export function enuToScene(e: number, n: number, u: number, out = new Vector3()): Vector3 {
    return out.set(e, u, -n);
}

export function inside(extent: Extent, x: number, y: number): boolean {
    return x >= extent.minX && x <= extent.maxX && y >= extent.minY && y <= extent.maxY;
}
