export interface LocationPreset {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Camera distance in meters for the fly-to. */
  range: number;
}

// Forested, fire-prone places to start a watch zone from.
export const PRESETS: LocationPreset[] = [
  { id: "angeles", name: "Angeles National Forest, CA", lat: 34.235, lon: -118.06, range: 14000 },
  { id: "santa-cruz", name: "Santa Cruz Mountains, CA", lat: 37.17, lon: -122.15, range: 14000 },
  { id: "boulder", name: "Boulder foothills, CO", lat: 40.0, lon: -105.32, range: 12000 },
  { id: "huron", name: "Huron-Manistee forests, MI", lat: 44.43, lon: -85.88, range: 14000 },
];

export const DEFAULT_LOCATION: LocationPreset = PRESETS[0]!;
