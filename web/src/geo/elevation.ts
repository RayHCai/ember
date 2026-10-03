import { Cartographic, EllipsoidTerrainProvider, sampleTerrainMostDetailed, type Viewer } from "cesium";
import type { MapSourceId } from "../state/store";
import type { LatLon } from "../types/events";
import { metersPerDegLon, pointInPolygon } from "./grid";

const SPACING_M = 300;
const MAX_SAMPLES = 1500;

/**
 * Terrain heights inside a zone as [lat, lon, height] samples, read from the
 * map: 3D tiles or Cesium World Terrain. Returns undefined when the map has
 * no terrain (the OpenStreetMap fallback), and the server uses flat ground.
 */
export async function sampleElevations(
  viewer: Viewer,
  map: MapSourceId | undefined,
  polygon: LatLon[],
): Promise<[number, number, number][] | undefined> {
  if (map === "osm" || (map !== "google" && viewer.terrainProvider instanceof EllipsoidTerrainProvider)) {
    return undefined;
  }
  const lats = polygon.map((p) => p[0]);
  const lons = polygon.map((p) => p[1]);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const area = (north - south) * 111_320 * (east - west) * metersPerDegLon((south + north) / 2);
  const spacing = Math.max(SPACING_M, Math.sqrt(area / MAX_SAMPLES));
  const dlat = spacing / 111_320;
  const dlon = spacing / metersPerDegLon((south + north) / 2);

  const points: LatLon[] = [];
  for (let lat = south + dlat / 2; lat < north; lat += dlat) {
    for (let lon = west + dlon / 2; lon < east; lon += dlon) {
      if (pointInPolygon([lat, lon], polygon)) points.push([lat, lon]);
    }
  }
  if (points.length === 0) return undefined;
  const cartos = points.map(([lat, lon]) => Cartographic.fromDegrees(lon, lat));

  try {
    const sampled =
      map === "google"
        ? await viewer.scene.sampleHeightMostDetailed(cartos)
        : await sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
    const out: [number, number, number][] = [];
    sampled.forEach((c, i) => {
      if (c && Number.isFinite(c.height)) out.push([points[i]![0], points[i]![1], c.height]);
    });
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
