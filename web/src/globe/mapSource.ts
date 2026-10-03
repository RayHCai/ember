import {
  createGooglePhotorealistic3DTileset,
  createWorldImageryAsync,
  createWorldTerrainAsync,
  Credit,
  GoogleMaps,
  Ion,
  OpenStreetMapImageryProvider,
  type Cesium3DTileset,
  type Viewer,
} from "cesium";
import { config } from "../config";
import type { MapSourceInfo } from "../state/store";

export interface LoadedMap {
  info: MapSourceInfo;
  tileset: Cesium3DTileset | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads the best map available: Google Photorealistic 3D Tiles, then Cesium
 * World Terrain with ion imagery, then OpenStreetMap imagery on the ellipsoid.
 * The returned info says which one loaded and why any fallback was used.
 */
export async function loadMap(viewer: Viewer): Promise<LoadedMap | null> {
  const reasons: string[] = [];
  if (config.ionToken) Ion.defaultAccessToken = config.ionToken;
  if (config.googleMapsKey) GoogleMaps.defaultApiKey = config.googleMapsKey;

  if (config.googleMapsKey || config.ionToken) {
    try {
      // Without a Google key this streams the same tiles through Cesium ion.
      // Search uses the Google geocoder while these tiles are on (see geocode.ts).
      const tileset = await createGooglePhotorealistic3DTileset(
        { key: config.googleMapsKey, onlyUsingWithGoogleGeocoder: true },
        { showCreditsOnScreen: true },
      );
      if (viewer.isDestroyed()) return null;
      viewer.scene.primitives.add(tileset);
      // The tiles include terrain, so the globe underneath would only z-fight.
      viewer.scene.globe.show = false;
      return { info: { id: "google", label: "Google 3D Tiles" }, tileset };
    } catch (err) {
      reasons.push(`Google 3D Tiles unavailable (${message(err)})`);
    }
  } else {
    reasons.push("No Google Maps or Cesium ion key set");
  }

  if (config.ionToken) {
    try {
      const [terrain, imagery] = await Promise.all([
        createWorldTerrainAsync(),
        createWorldImageryAsync(),
      ]);
      if (viewer.isDestroyed()) return null;
      viewer.terrainProvider = terrain;
      viewer.imageryLayers.addImageryProvider(imagery);
      return {
        info: { id: "ion", label: "Cesium World Terrain", fallbackReason: reasons.join(". ") },
        tileset: null,
      };
    } catch (err) {
      reasons.push(`Cesium ion unavailable (${message(err)})`);
    }
  }

  if (viewer.isDestroyed()) return null;
  const osm = viewer.imageryLayers.addImageryProvider(
    new OpenStreetMapImageryProvider({
      url: "https://tile.openstreetmap.org/",
      credit: new Credit(
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        true,
      ),
    }),
  );
  // The standard OSM style is bright. Dim it so the console stays dark and
  // the HUD and data layers read clearly on top.
  osm.brightness = 0.42;
  osm.contrast = 1.25;
  osm.saturation = 0.35;
  osm.gamma = 1.1;
  return {
    info: { id: "osm", label: "OpenStreetMap", fallbackReason: reasons.join(". ") },
    tileset: null,
  };
}
