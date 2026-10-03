import {
  Cartographic,
  IonGeocodeProviderType,
  IonGeocoderService,
  Math as CesiumMath,
  Rectangle,
  type Scene,
} from "cesium";
import { config } from "../config";
import type { MapSourceId } from "../state/store";

export interface GeocodeResult {
  name: string;
  lat: number;
  lon: number;
  /** Rough size of the place in meters, used to pick a camera distance. */
  extentM: number;
}

export interface GeocodeResponse {
  results: GeocodeResult[];
  attribution: string;
}

// Google Photorealistic 3D Tiles may only be used with the Google geocoder, so
// search follows the active map: Google while those tiles are on, else Nominatim.

export function geocoderLabel(map: MapSourceId | undefined): string {
  return map === "google" ? "Google" : "OpenStreetMap Nominatim";
}

export async function geocode(query: string, map: MapSourceId | undefined, scene: Scene): Promise<GeocodeResponse> {
  if (map === "google") {
    return config.ionToken ? googleViaIon(query, scene) : googleDirect(query);
  }
  return nominatim(query);
}

const METERS_PER_DEGREE = 111_320;

async function googleViaIon(query: string, scene: Scene): Promise<GeocodeResponse> {
  const service = new IonGeocoderService({ scene, geocodeProviderType: IonGeocodeProviderType.GOOGLE });
  const raw = await service.geocode(query);
  const results = raw.map((r): GeocodeResult => {
    if (r.destination instanceof Rectangle) {
      const center = Rectangle.center(r.destination);
      const extent = Math.max(r.destination.width, r.destination.height);
      return {
        name: r.displayName,
        lat: CesiumMath.toDegrees(center.latitude),
        lon: CesiumMath.toDegrees(center.longitude),
        extentM: CesiumMath.toDegrees(extent) * METERS_PER_DEGREE,
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
  return { results, attribution: "Search by Google" };
}

interface GoogleGeocodeJson {
  status: string;
  error_message?: string;
  results: {
    formatted_address: string;
    geometry: {
      location: { lat: number; lng: number };
      viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
    };
  }[];
}

async function googleDirect(query: string): Promise<GeocodeResponse> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", query);
  url.searchParams.set("key", config.googleMapsKey ?? "");
  const res = await fetch(url);
  const json = (await res.json()) as GoogleGeocodeJson;
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(json.error_message ?? `Google geocoding returned ${json.status}`);
  }
  const results = json.results.slice(0, 5).map((r): GeocodeResult => {
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
  return { results, attribution: "Search by Google" };
}

interface NominatimItem {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
}

async function nominatim(query: string): Promise<GeocodeResponse> {
  // Nominatim's usage policy: at most one request per second, no autocomplete.
  // Search only runs on submit.
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
  const items = (await res.json()) as NominatimItem[];
  const results = items.map((item): GeocodeResult => {
    const [south, north, west, east] = item.boundingbox.map(Number) as [number, number, number, number];
    return {
      name: item.display_name,
      lat: Number(item.lat),
      lon: Number(item.lon),
      extentM: Math.max(north - south, east - west) * METERS_PER_DEGREE,
    };
  });
  return { results, attribution: "Search by OpenStreetMap Nominatim" };
}
