import { Cartographic, Math as CesiumMath, type Cartesian2, type Cartesian3, type Viewer } from "cesium";

export interface PickedPoint {
  lat: number;
  lon: number;
  heightM: number;
  cartesian: Cartesian3;
}

/**
 * The point on the map under a screen position. Uses the depth buffer on 3D
 * tiles, the terrain surface on the globe, and the bare ellipsoid as a last resort.
 */
export function pickPoint(viewer: Viewer, windowPosition: Cartesian2): PickedPoint | null {
  const { scene, camera } = viewer;
  let cartesian: Cartesian3 | undefined;

  if (!scene.globe.show && scene.pickPositionSupported) {
    cartesian = scene.pickPosition(windowPosition);
  } else {
    const ray = camera.getPickRay(windowPosition);
    if (ray) cartesian = scene.globe.pick(ray, scene);
  }
  cartesian ??= camera.pickEllipsoid(windowPosition, scene.ellipsoid);
  if (!cartesian) return null;

  const carto = Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: CesiumMath.toDegrees(carto.latitude),
    lon: CesiumMath.toDegrees(carto.longitude),
    heightM: carto.height,
    cartesian,
  };
}
