import { spreadGrid } from "../../globe/spreadGrid";
import { cellCenter, makeGrid, pointInPolygon, polygonAreaKm2, projector, zoneCellIndexes } from "../../geo/grid";
import type {
  Community,
  EdgeServer,
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

// Dummy data for the console. Everything here is SIMULATED: a zone's roads,
// communities, docks, reports, fires and residents. The demo zone is written
// by hand; a zone the operator draws gets generated dummy data like it.

export interface Dock {
  id: string;
  lat: number;
  lon: number;
}

export interface Hotspot {
  at: LatLon;
  peak: number;
  spread_m: number;
}

export interface SiteNotes {
  drivers: string[];
  action: string;
  trend: ReportSite["trend"];
}

export interface Scenario {
  zone: Zone;
  map: ZoneMap;
  grid: GridInfo;
  cells: number[];
  docks: Dock[];
  hotspots: Hotspot[];
  siteNotes: SiteNotes[];
  /** Where the story's fire starts (the top report site). */
  fireSite: LatLon;
  headBearingDeg: number;
  /** Hand-written routes and messages for the demo zone. */
  routes?: (incidentId: string) => Route[];
  messages?: Partial<Record<Tier, string>>;
  summary?: string;
}

const M_PER_DEG = 111_320;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function offset([lat, lon]: LatLon, northM: number, eastM: number): LatLon {
  return [lat + northM / M_PER_DEG, lon + eastM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))];
}

function centroid(points: LatLon[]): LatLon {
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
}

function bearing(from: LatLon, to: LatLon): number {
  const [x, y] = projector(from)(to);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function distanceKm(a: LatLon, b: LatLon): number {
  const [x, y] = projector(a)(b);
  return Math.hypot(x, y) / 1000;
}

export function dronesOf(docks: Dock[]): string[] {
  return docks.flatMap((d) => [`${d.id}-d1`, `${d.id}-d2`]);
}

export function dockOf(sc: Scenario, droneId: string): Dock {
  return sc.docks.find((d) => droneId.startsWith(`${d.id}-`)) ?? sc.docks[0]!;
}

export function nearestDock(sc: Scenario, p: LatLon): Dock {
  return sc.docks.reduce((best, d) => (distanceKm(p, [d.lat, d.lon]) < distanceKm(p, [best.lat, best.lon]) ? d : best));
}

export function insideZone(sc: Scenario, p: LatLon): boolean {
  return pointInPolygon(p, sc.zone.polygon);
}

// --- The demo zone -----------------------------------------------------------------------

const DEMO_ZONE: Zone = {
  id: "demo-angeles",
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

const DEMO_GRID = makeGrid(DEMO_ZONE.polygon);

const DEMO_MAP: ZoneMap = {
  source: "synthetic",
  note: "Dummy data. Roads are simplified; residents and fuel are simulated.",
  roads: [
    { id: "r-mtwilson", kind: "secondary", name: "Mount Wilson Toll Road", points: [[34.165, -118.06], [34.18, -118.065], [34.195, -118.063], [34.215, -118.06]] },
    { id: "r-baldwin", kind: "primary", name: "Baldwin Avenue", points: [[34.17, -118.052], [34.155, -118.052], [34.14, -118.051], [34.128, -118.05]] },
    { id: "r-sierra-madre", kind: "secondary", name: "Sierra Madre Boulevard", points: [[34.162, -118.12], [34.161, -118.09], [34.161, -118.06], [34.158, -118.03]] },
    { id: "r-santa-anita", kind: "primary", name: "Santa Anita Avenue", points: [[34.18, -118.035], [34.16, -118.036], [34.14, -118.036], [34.128, -118.036]] },
    { id: "r-altadena", kind: "secondary", name: "Altadena Drive", points: [[34.19, -118.13], [34.18, -118.12], [34.17, -118.1], [34.162, -118.09]] },
    { id: "r-chantry", kind: "residential", name: "Chantry Flat Road", points: [[34.168, -118.04], [34.18, -118.03], [34.195, -118.024]] },
  ],
  communities: [
    { id: "c-sierra-madre", name: "Sierra Madre", lat: 34.1617, lon: -118.0528, kind: "town", population: 10900 },
    { id: "c-arcadia", name: "Arcadia", lat: 34.1397, lon: -118.0353, kind: "town", population: 56000 },
    { id: "c-altadena", name: "Altadena", lat: 34.1897, lon: -118.1312, kind: "town", population: 42800 },
    { id: "c-bradbury", name: "Bradbury", lat: 34.1469, lon: -117.9706, kind: "village", population: 900 },
  ],
  shelters: [
    { id: "s-arcadia-hs", name: "Arcadia High School", lat: 34.1285, lon: -118.0467, kind: "school" },
    { id: "s-pasadena-cc", name: "Eaton Canyon community hall", lat: 34.158, lon: -118.115, kind: "community_centre" },
  ],
  grid: DEMO_GRID,
  elevation: "flat",
};

const DEMO_FIRE: LatLon = [34.188, -118.056];

export function demoScenario(): Scenario {
  return {
    zone: DEMO_ZONE,
    map: DEMO_MAP,
    grid: DEMO_GRID,
    cells: zoneCellIndexes(DEMO_GRID),
    docks: [
      { id: "edge-1", lat: 34.205, lon: -118.075 },
      { id: "edge-2", lat: 34.207, lon: -118.045 },
      { id: "edge-3", lat: 34.182, lon: -118.072 },
      { id: "edge-4", lat: 34.186, lon: -118.038 },
    ],
    hotspots: [
      { at: DEMO_FIRE, peak: 93, spread_m: 520 },
      { at: [34.204, -118.082], peak: 86, spread_m: 450 },
      { at: [34.178, -118.034], peak: 81, spread_m: 380 },
      { at: [34.211, -118.048], peak: 76, spread_m: 330 },
      { at: [34.176, -118.074], peak: 72, spread_m: 300 },
    ],
    siteNotes: [
      { drivers: ["Critically dry fuel", "Upwind of homes"], action: "Prioritize fuel clearing and survey again in 6 hours", trend: "up" },
      { drivers: ["Heavy brush", "Steep slope"], action: "Survey again in 6 hours", trend: "same" },
      { drivers: ["Dry grass", "Close to a road"], action: "Clear the roadside strip on Chantry Flat Road", trend: "new" },
      { drivers: ["Dense timber", "Dry fuel"], action: "Watch on the next survey", trend: "down" },
      { drivers: ["Heavy brush", "Close to homes"], action: "Watch on the next survey", trend: "same" },
    ],
    fireSite: DEMO_FIRE,
    headBearingDeg: 192, // downhill toward Sierra Madre
    routes: (incidentId) => [
      {
        id: "route-sierra-madre", incident_id: incidentId, community: "Sierra Madre", shelter: "Arcadia High School",
        path: [[34.1617, -118.0528], [34.155, -118.052], [34.14, -118.051], [34.1285, -118.0467]], distance_km: 4.1, eta_min: 11,
      },
      {
        id: "route-altadena", incident_id: incidentId, community: "Altadena", shelter: "Eaton Canyon community hall",
        path: [[34.1897, -118.1312], [34.18, -118.12], [34.17, -118.118], [34.158, -118.115]], distance_km: 3.6, eta_min: 9,
      },
    ],
    messages: {
      evacuate: "Demo alert. Evacuate now. Take Baldwin Avenue south to Arcadia High School.",
      prepare: "Demo alert. A wildfire is burning 3 km north of you. Be ready to leave on short notice.",
      watch: "Demo alert. A wildfire is burning in the San Gabriel foothills. No action needed now.",
    },
    summary:
      "Five sites score 72 or higher. The top site, 2.9 km north of Sierra Madre, scores 93 with critically dry fuel upwind of homes. The average score rose 3.1 points since the last survey. Clear fuel at the top site first and survey again in 6 hours.",
  };
}

// --- Dummy data for a zone the operator draws ---------------------------------------------

const TOWN_NAMES = ["Pine Hollow", "Cedar Flat", "Granite Springs", "Oak Terrace", "Juniper Bend", "Manzanita"];
const SHELTER_NAMES = ["Valley High School", "Ridge Community Hall", "Lakeside Elementary"];
const DRIVERS: string[][] = [
  ["Critically dry fuel", "Upwind of homes"],
  ["Heavy brush", "Steep slope"],
  ["Dry grass", "Close to a road"],
  ["Dense timber", "Dry fuel"],
  ["Heavy brush", "Close to homes"],
];
const ACTIONS = [
  "Prioritize fuel clearing and survey again in 6 hours",
  "Survey again in 6 hours",
  "Clear the roadside strip",
  "Watch on the next survey",
  "Watch on the next survey",
];

/** Dummy communities, shelters, roads and hotspots around a drawn zone (all SIM). */
export function scenarioForZone(zone: Zone, docks: Dock[] = []): Scenario {
  const rand = seeded(hash(zone.id));
  const grid = makeGrid(zone.polygon);
  const cells = zoneCellIndexes(grid);
  const center = centroid(zone.polygon);
  const radiusM = Math.sqrt((polygonAreaKm2(zone.polygon) * 1e6) / Math.PI);

  // Three towns just outside the zone, in different directions; shelters further out.
  const communities: Community[] = [0, 1, 2].map((k) => {
    const angle = (k * 2 * Math.PI) / 3 + rand() * 0.8;
    const d = radiusM + 900 + rand() * 1500;
    const [lat, lon] = offset(center, Math.cos(angle) * d, Math.sin(angle) * d);
    const name = TOWN_NAMES[(hash(zone.id) + k) % TOWN_NAMES.length]!;
    return { id: `c-${zone.id}-${k}`, name: `${name} (SIM)`, lat, lon, kind: "town", population: Math.round(2000 + rand() * 18000) };
  });
  const shelters: Shelter[] = [0, 1].map((k) => {
    const c = communities[k]!;
    const away = bearing(center, [c.lat, c.lon]);
    const [lat, lon] = offset([c.lat, c.lon], Math.cos((away * Math.PI) / 180) * 2500, Math.sin((away * Math.PI) / 180) * 2500);
    return { id: `s-${zone.id}-${k}`, name: `${SHELTER_NAMES[k]} (SIM)`, lat, lon, kind: "school" };
  });
  const roads = communities.map((c, k) => ({
    id: `r-${zone.id}-${k}`,
    kind: "secondary",
    name: null,
    points: [center, [c.lat, c.lon] as LatLon, [shelters[k % shelters.length]!.lat, shelters[k % shelters.length]!.lon] as LatLon],
  }));

  // Five report hotspots inside the zone, the first toward the nearest town.
  const inside = cells.map((c) => cellCenter(grid, c));
  const pick = () => inside[Math.floor(rand() * inside.length)] ?? center;
  const nearTown = inside.reduce(
    (best, p) => (distanceKm(p, [communities[0]!.lat, communities[0]!.lon]) < distanceKm(best, [communities[0]!.lat, communities[0]!.lon]) ? p : best),
    center,
  );
  const fireSite = centroid([center, nearTown]);
  const hotspots: Hotspot[] = [fireSite, pick(), pick(), pick(), pick()].map((at, i) => ({
    at,
    peak: [92, 85, 79, 74, 71][i]!,
    spread_m: [480, 420, 360, 320, 300][i]!,
  }));

  return {
    zone,
    map: {
      source: "synthetic",
      note: "Dummy data: towns, shelters, roads, fuel and residents around this zone are made up.",
      roads,
      communities,
      shelters,
      grid,
      elevation: "flat",
    },
    grid,
    cells,
    docks,
    hotspots,
    siteNotes: DRIVERS.map((drivers, i) => ({ drivers, action: ACTIONS[i]!, trend: (["up", "same", "new", "down", "same"] as const)[i]! })),
    fireSite,
    headBearingDeg: bearing(fireSite, [communities[0]!.lat, communities[0]!.lon]),
  };
}

/** Dummy edge server layout: a staggered lattice inside the zone, about 2.4 km apart. */
export function dummyEdgeLayout(sc: Scenario, spacingM = 2400): EdgeServer[] {
  const { grid } = sc;
  const south: LatLon = [grid.south, grid.west];
  const heightM = (grid.north - grid.south) * M_PER_DEG;
  const widthM = (grid.east - grid.west) * M_PER_DEG * Math.cos((grid.south * Math.PI) / 180);
  const points: LatLon[] = [];
  for (let row = 0, y = spacingM / 2; y < heightM; row++, y += spacingM * 0.87) {
    for (let x = (row % 2 ? spacingM : spacingM / 2); x < widthM; x += spacingM) {
      const p = offset(south, y, x);
      if (pointInPolygon(p, sc.zone.polygon)) points.push(p);
    }
  }
  if (points.length === 0) points.push(centroid(sc.zone.polygon));
  return points.map(([lat, lon], i) => ({ id: `edge-${i + 1}`, lat, lon, radius_m: 1500, status: "pending", near_road: true }));
}

// --- Report -------------------------------------------------------------------------------

export function reportCells(sc: Scenario): ReportCell[] {
  const rand = seeded(hash(sc.zone.id) ^ 11);
  const project = projector(sc.zone.polygon[0]!);
  const hot = sc.hotspots.map((h) => ({ ...h, xy: project(h.at) }));
  return sc.cells.map((i) => {
    const [lat, lon] = cellCenter(sc.grid, i);
    const [x, y] = project([lat, lon]);
    let score = 14 + rand() * 26;
    for (const h of hot) {
      const d2 = (x - h.xy[0]) ** 2 + (y - h.xy[1]) ** 2;
      score = Math.max(score, h.peak * Math.exp(-d2 / (2 * h.spread_m ** 2)) + rand() * 6);
    }
    return { lat, lon, score: Math.min(100, Math.round(score)) };
  });
}

export function makeReport(sc: Scenario, surveyId: string, createdAt: string): Report {
  const sites: ReportSite[] = sc.hotspots.map((h, i) => {
    const nearest = sc.map.communities.reduce((best, c) => (distanceKm(h.at, [c.lat, c.lon]) < distanceKm(h.at, [best.lat, best.lon]) ? c : best));
    const notes = sc.siteNotes[i]!;
    return {
      id: `site-${i + 1}`,
      rank: i + 1,
      lat: h.at[0],
      lon: h.at[1],
      area_ha: Math.round(h.spread_m / 12),
      peak_score: h.peak,
      drivers: notes.drivers,
      nearest_community: nearest.name,
      community_distance_km: Math.round(distanceKm(h.at, [nearest.lat, nearest.lon]) * 10) / 10,
      action: notes.action,
      trend: notes.trend,
      capture_id: null,
    };
  });
  const top = sites[0]!;
  return {
    id: `report-${surveyId}`,
    survey_id: surveyId,
    created_at: createdAt,
    summary:
      sc.summary ??
      `Five sites score ${sites[4]!.peak_score} or higher. The top site, ${top.community_distance_km} km from ${top.nearest_community}, scores ${top.peak_score} with ${top.drivers[0]!.toLowerCase()}. Clear fuel at the top site first and survey again in 6 hours.`,
    mode: "template",
    cells: reportCells(sc),
    sites,
    trend: { avg_score_change: 3.1, new_sites: 1, dropped_sites: 1 },
  };
}

// --- Fire ---------------------------------------------------------------------------------

const HEAD_M_PER_MIN = 24; // wind-driven chaparral, red flag conditions
const FLANK_M_PER_MIN = 5.5;
const BACK_M_PER_MIN = 2.5;
const CELL_M = 100;
const HORIZON_MIN = 360;

/**
 * A dummy spread field shaped like a wind-driven fire: fastest at the head,
 * slow at the back. `slowdown` (0 to 1) shrinks the head run, standing in for
 * a prediction that includes suppression.
 */
export function spreadField(sc: Scenario, ignition: LatLon, incidentId: string, slowdown = 0): Spread {
  const project = projector(ignition);
  const kLat = 1 / M_PER_DEG;
  const kLon = 1 / (M_PER_DEG * Math.cos((ignition[0] * Math.PI) / 180));
  const theta = (sc.headBearingDeg * Math.PI) / 180;
  const head = HEAD_M_PER_MIN * (1 - 0.75 * slowdown);
  const flank = FLANK_M_PER_MIN * (1 - 0.5 * slowdown);
  const reach = head * HORIZON_MIN;
  const cells: [number, number, number][] = [];
  for (let y = -reach; y <= reach; y += CELL_M) {
    for (let x = -reach; x <= reach; x += CELL_M) {
      const u = x * Math.sin(theta) + y * Math.cos(theta);
      const v = x * Math.cos(theta) - y * Math.sin(theta);
      const along = u >= 0 ? u / head : u / BACK_M_PER_MIN;
      const minutes = Math.sqrt(along * along + (v / flank) ** 2);
      if (minutes <= HORIZON_MIN) cells.push([ignition[0] + y * kLat, ignition[1] + x * kLon, Math.round(minutes)]);
    }
  }
  const communities = sc.map.communities.map((c) => {
    const [cx, cy] = project([c.lat, c.lon]);
    let best: number | null = null;
    for (const [lat, lon, m] of cells) {
      const [x, y] = project([lat, lon]);
      if ((x - cx) ** 2 + (y - cy) ** 2 < 300 ** 2) best = best === null ? m : Math.min(best, m);
    }
    return { name: c.name, lat: c.lat, lon: c.lon, arrival_min: best };
  });
  return { incident_id: incidentId, cell_m: CELL_M, cells, head_bearing_deg: sc.headBearingDeg, horizon_min: HORIZON_MIN, communities, with_suppression: slowdown > 0 };
}

/** The band of cells the fire reaches 20 to 60 minutes out along its head. */
export function headBand(spread: Spread): LatLon[] {
  return spread.cells.filter(([, , m]) => m >= 20 && m <= 60).map(([lat, lon]) => [lat, lon] as LatLon);
}

/** Dummy routes: each threatened town to its nearest shelter. */
export function routesFor(sc: Scenario, incidentId: string, spread: Spread): Route[] {
  if (sc.routes) return sc.routes(incidentId);
  return spread.communities
    .filter((c) => c.arrival_min !== null)
    .map((c, k) => {
      const shelter = sc.map.shelters.reduce((best, s) => (distanceKm([c.lat, c.lon], [s.lat, s.lon]) < distanceKm([c.lat, c.lon], [best.lat, best.lon]) ? s : best));
      const mid = offset(centroid([[c.lat, c.lon], [shelter.lat, shelter.lon]]), 150, -150);
      const km = distanceKm([c.lat, c.lon], [shelter.lat, shelter.lon]) * 1.15;
      return {
        id: `route-${k}`,
        incident_id: incidentId,
        community: c.name,
        shelter: shelter.name,
        path: [[c.lat, c.lon], mid, [shelter.lat, shelter.lon]],
        distance_km: Math.round(km * 10) / 10,
        eta_min: Math.max(4, Math.round((km / 25) * 60)),
      };
    });
}

export function alertText(sc: Scenario, tier: Tier, route?: Route): string {
  const custom = sc.messages?.[tier];
  if (custom) return custom;
  if (tier === "evacuate") return `Demo alert. Evacuate now. Go to ${route?.shelter ?? "the nearest shelter"}.`;
  if (tier === "prepare") return "Demo alert. A wildfire is burning near you. Be ready to leave on short notice.";
  return `Demo alert. A wildfire is burning near ${sc.zone.name}. No action needed now.`;
}

/** About 300 dummy residents around the communities, tiered for display. */
export function residents(sc: Scenario, fire: LatLon, spread: Spread): Resident[] {
  const rand = seeded(hash(sc.zone.id) ^ 29);
  const project = projector(fire);
  const total = sc.map.communities.reduce((s, c) => s + (c.population ?? 1000), 0);
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
  for (const c of sc.map.communities) {
    const n = Math.max(12, Math.round((300 * (c.population ?? 1000)) / total));
    for (let k = 0; k < n; k++) {
      const [lat, lon] = offset([c.lat, c.lon], (rand() - 0.5) * 2800, (rand() - 0.5) * 2800);
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
