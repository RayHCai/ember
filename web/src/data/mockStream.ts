import { makeGrid, zoneCellIndexes } from "../geo/grid";
import type {
  Drone,
  EdgePlan,
  EmberEvent,
  KnownEvent,
  LatLon,
  Report,
  ReportCell,
  Snapshot,
  Zone,
  ZoneMap,
} from "../types/events";

// Sample events of every kind, on a timer, so the UI can be built and tested
// without the server. Enabled with VITE_USE_MOCK=1. Everything here is fake,
// and the top bar says so while it runs.

const ZONE_ID = "mock-zone";
const SIM_SPEED = 60;
const LOOP_MS = 32_000;
const TELEMETRY_MS = 250;

const ZONE: Zone = {
  id: ZONE_ID,
  name: "Angeles foothills (mock)",
  polygon: [
    [34.258, -118.1],
    [34.262, -118.04],
    [34.238, -118.018],
    [34.208, -118.03],
    [34.205, -118.088],
  ],
  area_km2: 27.4,
};

const DOCKS = [
  { id: "edge-1", lat: 34.247, lon: -118.08 },
  { id: "edge-2", lat: 34.248, lon: -118.045 },
  { id: "edge-3", lat: 34.22, lon: -118.07 },
  { id: "edge-4", lat: 34.222, lon: -118.038 },
];

const ZONE_MAP: ZoneMap = {
  source: "synthetic",
  note: "Mock data. Roads, places and shelters are made up.",
  roads: [
    { id: "mock-r1", kind: "secondary", name: "Mock Ridge Road", points: [[34.248, -118.105], [34.246, -118.07], [34.25, -118.035], [34.244, -118.012]] },
    { id: "mock-r2", kind: "residential", name: null, points: [[34.2, -118.07], [34.222, -118.068], [34.236, -118.06]] },
  ],
  communities: [
    { id: "mock-c1", name: "Sierra Madre (mock)", lat: 34.198, lon: -118.05, kind: "town", population: 10900 },
    { id: "mock-c2", name: "Altadena (mock)", lat: 34.205, lon: -118.11, kind: "town", population: 42800 },
  ],
  shelters: [
    { id: "mock-s1", name: "Arcadia High School (mock)", lat: 34.185, lon: -118.04, kind: "school" },
    { id: "mock-s2", name: "Community hall (mock)", lat: 34.19, lon: -118.1, kind: "community_centre" },
  ],
  grid: makeGrid(ZONE.polygon),
  elevation: "flat",
};

const EDGE_PLAN: EdgePlan = {
  servers: DOCKS.map((d) => ({ ...d, radius_m: 1500, status: "deployed" as const })),
  coverage_pct: 93.5,
};

/** Small deterministic PRNG so the mock looks the same on every load. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function reportCells(): ReportCell[] {
  const rand = seeded(7);
  const cells: ReportCell[] = [];
  const hot: LatLon[] = [
    [34.244, -118.062],
    [34.222, -118.085],
    [34.214, -118.04],
  ];
  for (let lat = 34.207; lat <= 34.26; lat += 0.0027) {
    for (let lon = -118.098; lon <= -118.02; lon += 0.0033) {
      let score = 18 + rand() * 22;
      for (const [hl, ho] of hot) {
        const d = Math.hypot((lat - hl) * 111, (lon - ho) * 92);
        score += 62 * Math.exp(-(d * d) / 0.9);
      }
      cells.push({ lat, lon, score: Math.min(100, Math.round(score)) });
    }
  }
  return cells;
}

function makeReport(n: number, at: number): Report {
  return {
    id: `mock-report-${n}`,
    survey_id: `mock-survey-${n}`,
    created_at: new Date(at).toISOString(),
    summary:
      "Three sites stand out. The ridge above Sierra Madre scores 91 with dry chaparral upwind of homes 1.2 km away. Two drainages to the west score 84 and 77. Recommend clearing fuel near the ridge and surveying again in 6 hours.",
    mode: "template",
    cells: reportCells(),
    sites: [
      {
        id: "site-1", rank: 1, lat: 34.244, lon: -118.062, area_ha: 38, peak_score: 91,
        drivers: ["Very dry fuel", "Upwind of homes"], nearest_community: "Sierra Madre",
        community_distance_km: 1.2, action: "Prioritize fuel clearing and survey again in 6 hours",
        trend: "up", capture_id: null,
      },
      {
        id: "site-2", rank: 2, lat: 34.222, lon: -118.085, area_ha: 24, peak_score: 84,
        drivers: ["Heavy brush", "Steep slope"], nearest_community: "Altadena",
        community_distance_km: 2.6, action: "Survey again in 6 hours", trend: "same", capture_id: null,
      },
      {
        id: "site-3", rank: 3, lat: 34.214, lon: -118.04, area_ha: 15, peak_score: 77,
        drivers: ["Dry grass", "Near a road"], nearest_community: "Arcadia",
        community_distance_km: 3.1, action: "Watch on the next survey", trend: "new", capture_id: null,
      },
    ],
    trend: { avg_score_change: 2.4, new_sites: 1, dropped_sites: 0 },
  };
}

function drone(i: number, tMs: number, surveying: boolean): Drone {
  const dock = DOCKS[i % DOCKS.length]!;
  const phase = tMs / 9000 + i * 1.7;
  const r = surveying ? 0.006 + 0.002 * Math.sin(tMs / 4000 + i) : 0;
  const lat = dock.lat + r * Math.sin(phase);
  const lon = dock.lon + r * 1.2 * Math.cos(phase);
  const heading = ((Math.atan2(Math.cos(phase), -Math.sin(phase)) * 180) / Math.PI + 360) % 360;
  return {
    id: `drone-${i + 1}`,
    lat,
    lon,
    alt_m: surveying ? 120 : 0,
    heading_deg: heading,
    battery_pct: surveying ? Math.max(25, 100 - ((tMs % LOOP_MS) / LOOP_MS) * 70) : 100,
    state: surveying ? "surveying" : "docked",
    dock_id: dock.id,
  };
}

export function startMockStream(emit: (event: KnownEvent) => void): () => void {
  const startedAt = Date.now();
  const simStart = startedAt;
  const simTime = (now: number) => new Date(simStart + (now - startedAt) * SIM_SPEED).toISOString();
  const ev = <K extends string, P>(kind: K, payload: P, now = Date.now()) =>
    ({ kind, zone_id: ZONE_ID, ts: simTime(now), payload }) as unknown as KnownEvent;

  const snapshot: Snapshot = {
    sim: { sim_time: simTime(startedAt), speed: SIM_SPEED, paused: false },
    zones: [ZONE],
    zone_maps: { [ZONE_ID]: ZONE_MAP },
    survey_cells: {},
    edge_plans: { [ZONE_ID]: EDGE_PLAN },
    drones: DOCKS.flatMap((_, i) => [drone(i, 0, false), drone(i + DOCKS.length, 0, false)]),
    surveys: {
      [ZONE_ID]: { id: "mock-survey-0", status: "scheduled", progress_pct: 0, next_at: simTime(startedAt + 3000) },
    },
    reports: {},
    captures: [],
    incidents: [],
    approvals: [],
    notifications: [],
    suppression: [],
    log: [ev("log", { message: "Mock stream started. All data on screen is simulated." }, startedAt) as EmberEvent],
  };
  emit({ kind: "snapshot", zone_id: ZONE_ID, ts: simTime(startedAt), payload: snapshot });

  const timers: number[] = [];
  let loop = 0;
  let surveying = false;

  const telemetry = window.setInterval(() => {
    const t = Date.now() - startedAt;
    for (let i = 0; i < 4; i++) emit(ev("drone", drone(i, t, surveying)));
  }, TELEMETRY_MS);

  const runLoop = () => {
    loop += 1;
    const n = loop;
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const surveyId = `mock-survey-${n}`;
    const incidentId = `mock-incident-${n}`;
    const fire: LatLon = [34.241, -118.066];

    at(500, () => {
      surveying = true;
      emit(ev("survey", { id: surveyId, status: "running", progress_pct: 0, next_at: null }));
      emit(ev("log", { message: "Survey started: 8 drones from 4 docks." }));
    });
    const cells = zoneCellIndexes(ZONE_MAP.grid);
    for (let p = 1; p <= 10; p++) {
      at(500 + p * 1800, () => {
        emit(ev("survey", { id: surveyId, status: "running", progress_pct: p * 10, next_at: null }));
        const chunk = cells.slice(Math.floor(((p - 1) * cells.length) / 10), Math.floor((p * cells.length) / 10));
        emit(ev("survey_cells", { survey_id: surveyId, cells: chunk, reset: p === 1 }));
      });
    }
    at(4000, () =>
      emit(ev("capture", {
        id: `mock-capture-${n}`, survey_id: surveyId, lat: fire[0], lon: fire[1],
        image_url: null, kind: "thermal", simulated: true,
      })),
    );
    at(6000, () => {
      emit(ev("incident", { id: incidentId, lat: fire[0], lon: fire[1], status: "suspected", confidence: 0.62 }));
      emit(ev("dispatch", { message: "Sent drone-2 to verify a thermal anomaly.", drone_id: "drone-2" }));
    });
    at(9000, () => {
      emit(ev("incident", { id: incidentId, lat: fire[0], lon: fire[1], status: "confirmed", confidence: 0.86 }));
      emit(ev("spread", {
        message: "Predicted spread: head runs south-southwest, reaching Sierra Madre in about 2 hours.",
        head_bearing_deg: 200,
        cells: [[fire[0], fire[1], 0], [fire[0] - 0.004, fire[1] - 0.002, 40], [fire[0] - 0.009, fire[1] - 0.004, 95]],
      }));
      emit(ev("route", {
        message: "Evacuation route from Sierra Madre to Arcadia High School, 6.8 km.",
        path: [[34.165, -118.053], [34.155, -118.045], [34.14, -118.04]],
      }));
    });
    at(11000, () => {
      emit(ev("approval_request", {
        id: `mock-approval-${n}`,
        reason: "Watch-tier alert for 112 residents is waiting for approval.",
        texts: ["Demo alert. A wildfire is burning 8 km north of you. Be ready to leave."],
      }));
      emit(ev("notification", {
        id: `mock-note-${n}`, tier: "evacuate", recipients_count: 46,
        text: "Demo alert. Evacuate now. Take Baldwin Ave south to Arcadia High School.",
        audio_url: null, approved_by: "auto",
      }));
      emit(ev("alert", { message: "Sent evacuate alerts to 46 residents (SIM)." }));
    });
    for (let s = 1; s <= 4; s++) {
      at(12000 + s * 2000, () =>
        emit(ev("suppression", {
          incident_id: incidentId, sorties_done: s, sorties_planned: 4,
          containment_pct: s * 22, treated_cells: [[fire[0] - 0.003 * s, fire[1]]], simulated: true,
        })),
      );
    }
    at(20000, () => {
      surveying = false;
      emit(ev("survey", { id: surveyId, status: "complete", progress_pct: 100, next_at: simTime(Date.now() + LOOP_MS) }));
      emit(ev("report", makeReport(n, Date.now())));
      emit(ev("incident", { id: incidentId, lat: fire[0], lon: fire[1], status: "contained", confidence: 0.86 }));
      emit(ev("decision", {
        summary: "Fire contained. Alerts sent, report filed, next survey scheduled.",
        approval_id: `mock-approval-${n}`,
      }));
    });
    at(LOOP_MS, runLoop);
  };
  timers.push(window.setTimeout(runLoop, 1000));

  return () => {
    window.clearInterval(telemetry);
    timers.forEach((t) => window.clearTimeout(t));
  };
}
