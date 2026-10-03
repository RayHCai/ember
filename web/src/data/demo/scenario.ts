import { spreadGrid } from "../../globe/spreadGrid";
import { cellCenter, makeGrid, pointInPolygon, projector, zoneCellIndexes } from "../../geo/grid";
import type {
  Community,
  EdgePlan,
  GridInfo,
  LatLon,
  Report,
  ReportCell,
  ReportSite,
  Resident,
  Route,
  Shelter,
  Spread,
  Tier,
  Zone,
  ZoneMap,
} from "../../types/events";

// The demo scenario: fixed sample data for the console to display. Everything
// here is SIMULATED and only stands in until the logic service sends real
// events. Nothing here decides anything for the operator.

export const ZONE_ID = "demo-angeles";

export const ZONE: Zone = {
  id: ZONE_ID,
  name: "Angeles foothills",
  polygon: [
    [34.215, -118.09],
    [34.219, -118.035],
    [34.2, -118.018],
    [34.174, -118.028],
    [34.171, -118.084],
  ],
  area_km2: 21.4,
};

export const GRID: GridInfo = makeGrid(ZONE.polygon);
export const ZONE_CELLS = zoneCellIndexes(GRID);

export const COMMUNITIES: Community[] = [
  { id: "c-sierra-madre", name: "Sierra Madre", lat: 34.1617, lon: -118.0528, kind: "town", population: 10900 },
  { id: "c-arcadia", name: "Arcadia", lat: 34.1397, lon: -118.0353, kind: "town", population: 56000 },
  { id: "c-altadena", name: "Altadena", lat: 34.1897, lon: -118.1312, kind: "town", population: 42800 },
  { id: "c-bradbury", name: "Bradbury", lat: 34.1469, lon: -117.9706, kind: "village", population: 900 },
];

export const SHELTERS: Shelter[] = [
  { id: "s-arcadia-hs", name: "Arcadia High School", lat: 34.1285, lon: -118.0467, kind: "school" },
  { id: "s-pasadena-cc", name: "Eaton Canyon community hall", lat: 34.158, lon: -118.115, kind: "community_centre" },
];

const ROADS: ZoneMap["roads"] = [
  { id: "r-mtwilson", kind: "secondary", name: "Mount Wilson Toll Road", points: [[34.165, -118.06], [34.18, -118.065], [34.195, -118.063], [34.215, -118.06]] },
  { id: "r-baldwin", kind: "primary", name: "Baldwin Avenue", points: [[34.17, -118.052], [34.155, -118.052], [34.14, -118.051], [34.128, -118.05]] },
  { id: "r-sierra-madre", kind: "secondary", name: "Sierra Madre Boulevard", points: [[34.162, -118.12], [34.161, -118.09], [34.161, -118.06], [34.158, -118.03]] },
  { id: "r-santa-anita", kind: "primary", name: "Santa Anita Avenue", points: [[34.18, -118.035], [34.16, -118.036], [34.14, -118.036], [34.128, -118.036]] },
  { id: "r-altadena", kind: "secondary", name: "Altadena Drive", points: [[34.19, -118.13], [34.18, -118.12], [34.17, -118.1], [34.162, -118.09]] },
  { id: "r-chantry", kind: "residential", name: "Chantry Flat Road", points: [[34.168, -118.04], [34.18, -118.03], [34.195, -118.024]] },
];

export const ZONE_MAP: ZoneMap = {
  source: "synthetic",
  note: "Demo data. Roads are simplified; residents and fuel are simulated.",
  roads: ROADS,
  communities: COMMUNITIES,
  shelters: SHELTERS,
  grid: GRID,
  elevation: "flat",
};

export const DOCKS = [
  { id: "edge-1", lat: 34.205, lon: -118.075 },
  { id: "edge-2", lat: 34.207, lon: -118.045 },
  { id: "edge-3", lat: 34.182, lon: -118.072 },
  { id: "edge-4", lat: 34.186, lon: -118.038 },
];

export const EDGE_PLAN: EdgePlan = {
  servers: DOCKS.map((d) => ({ ...d, radius_m: 1500, status: "deployed" as const, near_road: true })),
  coverage_pct: 96.4,
};

export const DRONE_IDS = DOCKS.flatMap((d) => [`${d.id}-d1`, `${d.id}-d2`]);

export function dockOf(droneId: string) {
  return DOCKS.find((d) => droneId.startsWith(d.id))!;
}

// --- Report ----------------------------------------------------------------------

export const FIRE_SITE: LatLon = [34.188, -118.056];

const HOTSPOTS: { at: LatLon; peak: number; spread_m: number }[] = [
  { at: FIRE_SITE, peak: 93, spread_m: 520 },
  { at: [34.204, -118.082], peak: 86, spread_m: 450 },
  { at: [34.178, -118.034], peak: 81, spread_m: 380 },
  { at: [34.211, -118.048], peak: 76, spread_m: 330 },
  { at: [34.176, -118.074], peak: 72, spread_m: 300 },
];

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function reportCells(): ReportCell[] {
  const rand = seeded(11);
  const project = projector(ZONE.polygon[0]!);
  const hot = HOTSPOTS.map((h) => ({ ...h, xy: project(h.at) }));
  return ZONE_CELLS.map((i) => {
    const [lat, lon] = cellCenter(GRID, i);
    const [x, y] = project([lat, lon]);
    let score = 14 + rand() * 26;
    for (const h of hot) {
      const d2 = (x - h.xy[0]) ** 2 + (y - h.xy[1]) ** 2;
      score = Math.max(score, h.peak * Math.exp(-d2 / (2 * h.spread_m ** 2)) + rand() * 6);
    }
    return { lat, lon, score: Math.min(100, Math.round(score)) };
  });
}

const SITES: Omit<ReportSite, "lat" | "lon" | "peak_score" | "rank">[] = [
  {
    id: "site-1", area_ha: 41, drivers: ["Critically dry fuel", "Upwind of homes"], nearest_community: "Sierra Madre",
    community_distance_km: 2.9, action: "Prioritize fuel clearing and survey again in 6 hours", trend: "up", capture_id: null,
  },
  {
    id: "site-2", area_ha: 28, drivers: ["Heavy brush", "Steep slope"], nearest_community: "Altadena",
    community_distance_km: 4.7, action: "Survey again in 6 hours", trend: "same", capture_id: null,
  },
  {
    id: "site-3", area_ha: 19, drivers: ["Dry grass", "Close to a road"], nearest_community: "Arcadia",
    community_distance_km: 3.5, action: "Clear the roadside strip on Chantry Flat Road", trend: "new", capture_id: null,
  },
  {
    id: "site-4", area_ha: 14, drivers: ["Dense timber", "Dry fuel"], nearest_community: "Sierra Madre",
    community_distance_km: 5.6, action: "Watch on the next survey", trend: "down", capture_id: null,
  },
  {
    id: "site-5", area_ha: 11, drivers: ["Heavy brush", "Close to homes"], nearest_community: "Altadena",
    community_distance_km: 3.8, action: "Watch on the next survey", trend: "same", capture_id: null,
  },
];

export function makeReport(surveyId: string, createdAt: string): Report {
  return {
    id: `report-${surveyId}`,
    survey_id: surveyId,
    created_at: createdAt,
    summary:
      "Five sites score 72 or higher. The top site, 2.9 km north of Sierra Madre, scores 93 with critically dry fuel upwind of homes. The average score rose 3.1 points since the last survey. Clear fuel at the top site first and survey again in 6 hours.",
    mode: "template",
    cells: reportCells(),
    sites: SITES.map((site, i) => ({
      ...site,
      rank: i + 1,
      lat: HOTSPOTS[i]!.at[0],
      lon: HOTSPOTS[i]!.at[1],
      peak_score: HOTSPOTS[i]!.peak,
    })),
    trend: { avg_score_change: 3.1, new_sites: 1, dropped_sites: 1 },
  };
}

// --- Fire --------------------------------------------------------------------------

const HEAD_BEARING_DEG = 192; // downhill toward Sierra Madre
const HEAD_M_PER_MIN = 24; // wind-driven chaparral, red flag conditions
const FLANK_M_PER_MIN = 5.5;
const BACK_M_PER_MIN = 2.5;
const CELL_M = 100;
const HORIZON_MIN = 360;

/**
 * A sample spread field shaped like a wind-driven fire: fastest at the head,
 * slow at the back. `slowdown` (0 to 1) shrinks the head run, standing in for
 * a prediction that includes suppression.
 */
export function spreadField(ignition: LatLon, incidentId: string, slowdown = 0): Spread {
  const project = projector(ignition);
  const kLat = 1 / 111_320;
  const kLon = 1 / (111_320 * Math.cos((ignition[0] * Math.PI) / 180));
  const theta = (HEAD_BEARING_DEG * Math.PI) / 180;
  const head = HEAD_M_PER_MIN * (1 - 0.75 * slowdown);
  const flank = FLANK_M_PER_MIN * (1 - 0.5 * slowdown);
  const reach = head * HORIZON_MIN;
  const cells: [number, number, number][] = [];
  for (let y = -reach; y <= reach; y += CELL_M) {
    for (let x = -reach; x <= reach; x += CELL_M) {
      // u along the head direction, v across it.
      const u = x * Math.sin(theta) + y * Math.cos(theta);
      const v = x * Math.cos(theta) - y * Math.sin(theta);
      const along = u >= 0 ? u / head : u / BACK_M_PER_MIN;
      const minutes = Math.sqrt(along * along + (v / flank) ** 2);
      if (minutes <= HORIZON_MIN) cells.push([ignition[0] + y * kLat, ignition[1] + x * kLon, Math.round(minutes)]);
    }
  }
  const communities = COMMUNITIES.map((c) => {
    const [cx, cy] = project([c.lat, c.lon]);
    let best: number | null = null;
    for (const [lat, lon, m] of cells) {
      const [x, y] = project([lat, lon]);
      if ((x - cx) ** 2 + (y - cy) ** 2 < 300 ** 2) best = best === null ? m : Math.min(best, m);
    }
    return { name: c.name, lat: c.lat, lon: c.lon, arrival_min: best };
  });
  return {
    incident_id: incidentId,
    cell_m: CELL_M,
    cells,
    head_bearing_deg: HEAD_BEARING_DEG,
    horizon_min: HORIZON_MIN,
    communities,
    with_suppression: slowdown > 0,
  };
}

/** The band of cells the fire reaches 20 to 60 minutes out along its head. */
export function headBand(spread: Spread): LatLon[] {
  return spread.cells.filter(([, , m]) => m >= 20 && m <= 60).map(([lat, lon]) => [lat, lon] as LatLon);
}

export function routesFor(incidentId: string): Route[] {
  return [
    {
      id: "route-sierra-madre",
      incident_id: incidentId,
      community: "Sierra Madre",
      shelter: "Arcadia High School",
      path: [[34.1617, -118.0528], [34.155, -118.052], [34.14, -118.051], [34.1285, -118.0467]],
      distance_km: 4.1,
      eta_min: 11,
    },
    {
      id: "route-altadena",
      incident_id: incidentId,
      community: "Altadena",
      shelter: "Eaton Canyon community hall",
      path: [[34.1897, -118.1312], [34.18, -118.12], [34.17, -118.118], [34.158, -118.115]],
      distance_km: 3.6,
      eta_min: 9,
    },
  ];
}

/** About 300 sample residents around the communities, tiered for display. */
export function residents(fire: LatLon, spread: Spread): Resident[] {
  const rand = seeded(29);
  const project = projector(fire);
  const total = COMMUNITIES.reduce((s, c) => s + (c.population ?? 1000), 0);
  const sg = spreadGrid(spread);
  const arrivalAt = (lat: number, lon: number): number | undefined => {
    if (!sg) return undefined;
    const row = Math.floor((lat - sg.grid.south) / sg.grid.dlat);
    const col = Math.floor((lon - sg.grid.west) / sg.grid.dlon);
    if (row < 0 || row >= sg.grid.rows || col < 0 || col >= sg.grid.cols) return undefined;
    const m = sg.arrival[row * sg.grid.cols + col]!;
    return Number.isFinite(m) ? m : undefined;
  };
  const out: Resident[] = [];
  for (const c of COMMUNITIES) {
    const n = Math.max(12, Math.round((300 * (c.population ?? 1000)) / total));
    for (let k = 0; k < n; k++) {
      const r = 250 + rand() * 1400;
      const a = rand() * Math.PI * 2;
      const lat = c.lat + (Math.sin(a) * r) / 111_320;
      const lon = c.lon + (Math.cos(a) * r) / (111_320 * Math.cos((c.lat * Math.PI) / 180));
      const [x, y] = project([lat, lon]);
      const km = Math.hypot(x, y) / 1000;
      const m = arrivalAt(lat, lon);
      let tier: Tier | null = null;
      if ((m !== undefined && m <= 90) || km <= 1.5) tier = "evacuate";
      else if ((m !== undefined && m <= 180) || km <= 4) tier = "prepare";
      else if (km <= 10) tier = "watch";
      out.push({ id: `res-${c.id}-${k}`, lat, lon, tier, community: c.name });
    }
  }
  return out;
}

export function nearestDock(p: LatLon) {
  const project = projector(p);
  return DOCKS.reduce((best, d) => {
    const [x, y] = project([d.lat, d.lon]);
    const dist = Math.hypot(x, y);
    return dist < best.dist ? { dock: d, dist } : best;
  }, { dock: DOCKS[0]!, dist: Infinity }).dock;
}

export function insideZone(p: LatLon): boolean {
  return pointInPolygon(p, ZONE.polygon);
}
