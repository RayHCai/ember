import { Cesium3DTileset, type Viewer } from "cesium";

/** True once the globe and any 3D tileset have loaded the tiles in view. */
export function tilesLoaded(viewer: Viewer): boolean {
  const { scene } = viewer;
  if (scene.globe.show && !scene.globe.tilesLoaded) return false;
  for (let i = 0; i < scene.primitives.length; i++) {
    const p = scene.primitives.get(i);
    if (p instanceof Cesium3DTileset && !p.tilesLoaded) return false;
  }
  return true;
}

export async function waitForTiles(viewer: Viewer, timeoutMs = 5000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until && !viewer.isDestroyed() && !tilesLoaded(viewer)) {
    await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * The current view as a JPEG, with data layers hidden so it reads as a photo
 * of the place. Used for simulated site captures (labeled as such).
 */
export function captureView(viewer: Viewer, opts: { hideLayers?: boolean } = {}): string {
  const { scene } = viewer;
  const restore: (() => void)[] = [];
  if (opts.hideLayers !== false) {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.show) {
        ds.show = false;
        restore.push(() => (ds.show = true));
      }
    }
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i) as { show?: boolean };
      if (!(p instanceof Cesium3DTileset) && p.show) {
        p.show = false;
        restore.push(() => (p.show = true));
      }
    }
  }
  viewer.render();
  const url = viewer.canvas.toDataURL("image/jpeg", 0.86);
  restore.forEach((r) => r());
  viewer.render();
  return url;
}
