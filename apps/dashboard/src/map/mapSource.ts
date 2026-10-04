import {
    createGooglePhotorealistic3DTileset,
    createWorldImageryAsync,
    createWorldTerrainAsync,
    Credit,
    CustomShader,
    GoogleMaps,
    Ion,
    LightingModel,
    OpenStreetMapImageryProvider,
    UniformType,
    type Cesium3DTileset,
    type ImageryLayer,
    type Viewer,
} from 'cesium';
import { config } from '../config';
import type { MapSourceInfo } from './viewer';

export interface LoadedMap {
    info: MapSourceInfo;
    /** Sets how much color the base map keeps: 1 full color, 0 black and white. */
    setSaturation: (value: number) => void;
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function imageryControl(layer: ImageryLayer, full: number): (value: number) => void {
    return (value) => {
        layer.saturation = full * value;
        layer.brightness = 1 + (1 - value) * 0.12;
        layer.contrast = 1 - (1 - value) * 0.12;
    };
}

function tilesetControl(tileset: Cesium3DTileset): (value: number) => void {
    const shader = new CustomShader({
        lightingModel: LightingModel.UNLIT,
        uniforms: { u_saturation: { type: UniformType.FLOAT, value: 1 } },
        fragmentShaderText: /* glsl */ `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    float l = dot(material.diffuse, vec3(0.299, 0.587, 0.114));
    vec3 gray = vec3(l) * 1.08 + 0.04;
    material.diffuse = mix(gray, material.diffuse, u_saturation);
}`,
    });
    tileset.customShader = shader;
    return (value) => shader.setUniform('u_saturation', value);
}

/**
 * Loads the best map available: Google Photorealistic 3D Tiles, then Cesium
 * World Terrain with ion imagery, then OpenStreetMap imagery on the ellipsoid.
 */
export async function loadMap(viewer: Viewer): Promise<LoadedMap | null> {
    const reasons: string[] = [];
    if (config.ionToken) Ion.defaultAccessToken = config.ionToken;
    if (config.googleMapsKey) GoogleMaps.defaultApiKey = config.googleMapsKey;

    if (config.googleMapsKey || config.ionToken) {
        try {
            // Search uses the Google geocoder while these tiles are on (see geocode.ts).
            const tileset = await createGooglePhotorealistic3DTileset(
                { key: config.googleMapsKey, onlyUsingWithGoogleGeocoder: true },
                { showCreditsOnScreen: true },
            );
            if (viewer.isDestroyed()) return null;
            viewer.scene.primitives.add(tileset);
            // The tiles include terrain, so the globe underneath would only z-fight.
            viewer.scene.globe.show = false;
            return {
                info: { id: 'google', label: 'Google 3D Tiles' },
                setSaturation: tilesetControl(tileset),
            };
        } catch (err) {
            reasons.push(`Google 3D Tiles unavailable (${message(err)})`);
        }
    } else {
        reasons.push('No Google Maps or Cesium ion key set');
    }

    if (config.ionToken) {
        try {
            const [terrain, imagery] = await Promise.all([
                createWorldTerrainAsync(),
                createWorldImageryAsync(),
            ]);
            if (viewer.isDestroyed()) return null;
            viewer.terrainProvider = terrain;
            const layer = viewer.imageryLayers.addImageryProvider(imagery);
            return {
                info: {
                    id: 'ion',
                    label: 'Cesium World Terrain',
                    fallbackReason: reasons.join('. '),
                },
                setSaturation: imageryControl(layer, 1),
            };
        } catch (err) {
            reasons.push(`Cesium ion unavailable (${message(err)})`);
        }
    }

    if (viewer.isDestroyed()) return null;
    const osm = viewer.imageryLayers.addImageryProvider(
        new OpenStreetMapImageryProvider({
            url: 'https://tile.openstreetmap.org/',
            credit: new Credit(
                '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
                true,
            ),
        }),
    );
    // A touch quieter than stock OSM so overlays carry the color.
    osm.saturation = 0.8;
    return {
        info: { id: 'osm', label: 'OpenStreetMap', fallbackReason: reasons.join('. ') },
        setSaturation: imageryControl(osm, 0.8),
    };
}
