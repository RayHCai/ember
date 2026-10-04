import type { ForestFitResult, LatLng, Weather, ZoneSurroundings } from '@ember/contracts';

export type FetchedSurroundings = Pick<
    ZoneSurroundings,
    'source' | 'civilianAreas' | 'roads' | 'safeZones' | 'stations'
>;

/** What the api reads from open map and weather data (OpenStreetMap through Overpass, Open-Meteo). */
export type OpenData = {
    /** Null when the outline holds no vegetation. Throws `OpenDataError` when data cannot be fetched. */
    fitForest(boundary: LatLng[]): Promise<ForestFitResult | null>;
    /** Throws `OpenDataError` when data cannot be fetched. */
    surroundings(boundary: LatLng[]): Promise<FetchedSurroundings>;
    /** Null when unavailable; never throws. */
    weather(at: LatLng): Promise<Weather | null>;
};

export class OpenDataError extends Error {
    override name = 'OpenDataError';
}
