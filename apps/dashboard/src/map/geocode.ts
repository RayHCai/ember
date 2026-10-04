import {
    Cartographic,
    IonGeocodeProviderType,
    IonGeocoderService,
    Math as CesiumMath,
    Rectangle,
    type Scene,
} from 'cesium';
import { config } from '../config';
import type { MapSourceId } from './viewer';

export interface GeocodeResult {
    name: string;
    lat: number;
    lon: number;
    /** Rough size of the place in metres. */
    extentM: number;
}

const METERS_PER_DEGREE = 111_320;

// Google Photorealistic 3D Tiles may only be used with the Google geocoder, so
// search follows the active map: Google while those tiles are on, else Nominatim.
export async function geocode(
    query: string,
    map: MapSourceId | undefined,
    scene: Scene,
): Promise<GeocodeResult[]> {
    if (map === 'google') return config.ionToken ? googleViaIon(query, scene) : googleDirect(query);
    return nominatim(query);
}

async function googleViaIon(query: string, scene: Scene): Promise<GeocodeResult[]> {
    const service = new IonGeocoderService({
        scene,
        geocodeProviderType: IonGeocodeProviderType.GOOGLE,
    });
    const raw = await service.geocode(query);
    return raw.map((r) => {
        if (r.destination instanceof Rectangle) {
            const center = Rectangle.center(r.destination);
            return {
                name: r.displayName,
                lat: CesiumMath.toDegrees(center.latitude),
                lon: CesiumMath.toDegrees(center.longitude),
                extentM:
                    CesiumMath.toDegrees(Math.max(r.destination.width, r.destination.height)) *
                    METERS_PER_DEGREE,
            };
        }
        const carto = Cartographic.fromCartesian(r.destination);
        return {
            name: r.displayName,
            lat: CesiumMath.toDegrees(carto.latitude),
            lon: CesiumMath.toDegrees(carto.longitude),
            extentM: 2000,
        };
    });
}

interface GoogleGeocodeJson {
    status: string;
    error_message?: string;
    results: {
        formatted_address: string;
        geometry: {
            location: { lat: number; lng: number };
            viewport?: {
                northeast: { lat: number; lng: number };
                southwest: { lat: number; lng: number };
            };
        };
    }[];
}

async function googleDirect(query: string): Promise<GeocodeResult[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('key', config.googleMapsKey ?? '');
    const json = (await (await fetch(url)).json()) as GoogleGeocodeJson;
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
        throw new Error(json.error_message ?? `Google geocoding returned ${json.status}`);
    }
    return json.results.slice(0, 5).map((r) => {
        const vp = r.geometry.viewport;
        const extentDeg = vp
            ? Math.max(vp.northeast.lat - vp.southwest.lat, vp.northeast.lng - vp.southwest.lng)
            : 0.02;
        return {
            name: r.formatted_address,
            lat: r.geometry.location.lat,
            lon: r.geometry.location.lng,
            extentM: extentDeg * METERS_PER_DEGREE,
        };
    });
}

interface NominatimItem {
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string];
}

async function nominatim(query: string): Promise<GeocodeResult[]> {
    // Nominatim's usage policy: at most one request per second, no autocomplete. Search runs on submit.
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('q', query);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
    const items = (await res.json()) as NominatimItem[];
    return items.map((item) => {
        const [south, north, west, east] = item.boundingbox.map(Number) as [
            number,
            number,
            number,
            number,
        ];
        return {
            name: item.display_name,
            lat: Number(item.lat),
            lon: Number(item.lon),
            extentM: Math.max(north - south, east - west) * METERS_PER_DEGREE,
        };
    });
}
