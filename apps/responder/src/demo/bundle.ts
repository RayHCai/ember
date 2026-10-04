import type {
    AttackZone,
    FireIsochrone,
    FuelType,
    LatLng,
    ResponderMessage,
    ResponderSession,
    ResponderZoneBundle,
    WatchZoneId,
} from '@ember/contracts';

/** A west-Maui hillside above a coastal town, with a trade-wind fire running downslope. */
const ORIGIN: LatLng = { lat: 20.872, lng: -156.672 };
const ZONE_ID = 'demo-west-maui' as WatchZoneId;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** `east` and `north` in metres from the zone origin. */
function at(east: number, north: number): LatLng {
    return { lat: ORIGIN.lat + north / M_PER_DEG_LAT, lng: ORIGIN.lng + east / M_PER_DEG_LNG };
}

/** Ellipse elongated along `headingDeg` (clockwise from north), its rear `back` metres behind `c`. */
function plume(
    c: [number, number],
    ahead: number,
    back: number,
    width: number,
    headingDeg: number,
) {
    const h = (headingDeg * Math.PI) / 180;
    const fwd = [Math.sin(h), Math.cos(h)] as const;
    const side = [Math.cos(h), -Math.sin(h)] as const;
    const pts: LatLng[] = [];
    for (let i = 0; i < 36; i++) {
        const t = (i / 36) * Math.PI * 2;
        const along = Math.cos(t) > 0 ? Math.cos(t) * ahead : Math.cos(t) * back;
        const across = Math.sin(t) * width * (1 + 0.08 * Math.sin(3 * t));
        pts.push(
            at(c[0] + fwd[0] * along + side[0] * across, c[1] + fwd[1] * along + side[1] * across),
        );
    }
    return pts;
}

function hash(x: number, y: number): number {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

function noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const COLS = 84;
const ROWS = 70;
const CELL_M = 60;
const SW = { east: -2600, north: -2100 };

function fuelAt(col: number, row: number): FuelType {
    const east = SW.east + (col + 0.5) * CELL_M;
    const north = SW.north + (row + 0.5) * CELL_M;
    const coast = -1900 + 260 * Math.sin(north / 700);
    if (east < coast) return 'none';
    if (east < coast + 900 && Math.abs(north + 150) < 850) return 'urban';
    const n = noise(col / 9, row / 9) * 0.7 + noise(col / 3, row / 3) * 0.3;
    const upslope = (east - coast) / 4200;
    const v = upslope + (n - 0.5) * 0.55;
    if (n > 0.86) return 'none';
    if (v < 0.28) return 'grass';
    if (v < 0.58) return 'shrub';
    return 'timber';
}

function terrain() {
    const fuel: FuelType[] = [];
    const elevationM: number[] = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            fuel.push(fuelAt(c, r));
            elevationM.push(Math.max(0, (c * CELL_M + SW.east + 1900) * 0.18));
        }
    }
    return {
        southWest: at(SW.east, SW.north),
        cellSizeM: CELL_M,
        cols: COLS,
        rows: ROWS,
        elevationM,
        fuel,
    };
}

const HEADING = 252;
const IGNITION: [number, number] = [1350, 450];

function isochrones(): FireIsochrone[] {
    return [30, 60, 90, 120, 150, 180].map((atMin) => {
        const k = atMin / 30;
        const ahead = 260 + 360 * k;
        const ring = plume(
            [IGNITION[0] - 40 * k, IGNITION[1] - 10 * k],
            ahead,
            180 + 60 * k,
            230 + 115 * k,
            HEADING,
        );
        return {
            atMin,
            areaHa: Math.round((Math.PI * ahead * (230 + 115 * k)) / 10_000),
            polygons: [{ outer: ring, holes: [] }],
        };
    });
}

function attackZones(): AttackZone[] {
    const zones: [number, number, number, AttackZone['tactic'], number, string[], number][] = [
        [300, 330, 260, 'indirect', 58, ['area-town-north', 'area-town-south'], 3400],
        [460, -380, 210, 'direct', 22, ['area-upcountry'], 620],
        [520, 960, 200, 'direct', 31, ['area-hillside'], 180],
        [-640, -520, 240, 'indirect', 128, ['area-town-south'], 1900],
    ];
    return zones.map(([e, n, radiusM, tactic, arrival, protects, pop], i) => ({
        id: `attack-${i + 1}`,
        rank: i + 1,
        center: at(e, n),
        radiusM,
        dropSite: at(e - 90, n + 40),
        score: [1, 0.82, 0.67, 0.54][i]!,
        fireArrivalMin: arrival,
        accessMin: [11, 7, 14, 18][i]!,
        spreadRateMpm: [14, 9, 8, 16][i]!,
        tactic,
        protects,
        protectedPopulation: pop,
        protectedAreaHa: [86, 41, 23, 64][i]!,
    }));
}

function messages(now: number): ResponderMessage[] {
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    const base = { zoneId: ZONE_ID, from: 'Ops · K. Akana' };
    return [
        {
            ...base,
            id: 'm4',
            kind: 'directive',
            priority: 'critical',
            title: 'Engine 3 to Site 1',
            body: 'Establish a line along Kuialua Rd before the head arrives. ETA of fire is under an hour.',
            sentAt: ago(2),
            location: at(300, 330),
        },
        {
            ...base,
            id: 'm3',
            kind: 'plan',
            priority: 'urgent',
            title: 'New attack plan',
            body: 'Planner recommends 4 sites. Wind ENE 11 m/s, gusting. Head fire moving WSW toward town.',
            sentAt: ago(9),
            from: 'ember',
            location: null,
        },
        {
            ...base,
            id: 'm2',
            kind: 'incident',
            priority: 'urgent',
            title: 'Active fire confirmed',
            body: 'Drone Kestrel-2 confirms open flame on the upper gulch, roughly 4 ha.',
            sentAt: ago(21),
            location: at(IGNITION[0], IGNITION[1]),
        },
        {
            ...base,
            id: 'm1',
            kind: 'update',
            priority: 'routine',
            title: 'Patrol started',
            body: 'Three drones patrolling the upper slopes. Red-flag conditions in effect.',
            sentAt: ago(64),
            from: 'ember',
            location: null,
        },
    ];
}

export const DEMO_SESSION: ResponderSession = {
    responderId: 'demo-responder',
    sessionToken: 'demo',
    zoneId: ZONE_ID,
    zoneName: 'West Maui Uplands',
    apiUrl: 'demo:',
    droneInfoUrl: null,
};

export function demoBundle(now = Date.now()): ResponderZoneBundle {
    const generatedAt = new Date(now - 4 * 60_000).toISOString();
    return {
        zoneId: ZONE_ID,
        name: DEMO_SESSION.zoneName,
        version: 'demo-1',
        generatedAt,
        boundary: [
            at(-1750, 1900),
            at(900, 2050),
            at(2350, 1500),
            at(2450, -900),
            at(1400, -1950),
            at(-1500, -1950),
            at(-2050, -400),
        ],
        terrain: terrain(),
        roads: [
            {
                id: 'r-hwy',
                name: 'Honoapiilani Hwy',
                kind: 'primary',
                path: [-2100, -1400, -700, 0, 700, 1400, 2100].map((n) =>
                    at(-1550 + 220 * Math.sin(n / 700), n),
                ),
            },
            {
                id: 'r-kuialua',
                name: 'Kuialua Rd',
                kind: 'secondary',
                path: [at(-1500, 300), at(-700, 320), at(-120, 260), at(600, 420), at(1500, 900)],
            },
            {
                id: 'r-gulch',
                name: null,
                kind: 'track',
                path: [at(-1400, -700), at(-200, -560), at(700, -300), at(1800, -50)],
            },
        ],
        civilianAreas: [
            {
                id: 'area-town-north',
                name: 'Kahana Mauka',
                center: at(-1250, 400),
                polygon: null,
                population: 2100,
            },
            {
                id: 'area-town-south',
                name: 'Puamana',
                center: at(-1300, -650),
                polygon: null,
                population: 1300,
            },
            {
                id: 'area-upcountry',
                name: 'Upcountry Ranch',
                center: at(250, -900),
                polygon: null,
                population: 620,
            },
            {
                id: 'area-hillside',
                name: 'Hillside Homes',
                center: at(250, 1250),
                polygon: null,
                population: 180,
            },
        ],
        safeZones: [
            { id: 'safe-harbor', name: 'Harbor Park', location: at(-1850, -200), capacity: 4000 },
            { id: 'safe-school', name: 'High School', location: at(-1650, 1400), capacity: 1500 },
        ],
        stations: [{ id: 'st-3', name: 'Station 3', location: at(-1500, -1500) }],
        weather: {
            observedAt: generatedAt,
            windSpeedMps: 11,
            windFromDeg: 72,
            temperatureC: 31,
            relativeHumidityPct: 18,
        },
        riskZones: [
            {
                id: 'risk-fire',
                risk: 'on_fire',
                polygon: plume(IGNITION, 230, 140, 160, HEADING),
                confidence: 0.94,
                observedAt: generatedAt,
            },
            {
                id: 'risk-ridge',
                risk: 'at_risk',
                polygon: plume([1500, 1250], 380, 300, 220, 200),
                confidence: 0.71,
                observedAt: generatedAt,
            },
            {
                id: 'risk-gulch',
                risk: 'at_risk',
                polygon: plume([1850, -650], 300, 260, 200, 230),
                confidence: 0.63,
                observedAt: generatedAt,
            },
        ],
        detections: [
            [1380, 470, 'on_fire', 0.96],
            [1240, 380, 'on_fire', 0.9],
            [1540, 1180, 'at_risk', 0.72],
        ].map(([e, n, risk, confidence], i) => ({
            id: `det-${i}`,
            risk: risk as 'on_fire' | 'at_risk',
            confidence: confidence as number,
            bboxPx: [0, 0, 0, 0],
            ground: [],
            center: at(e as number, n as number),
            areaM2: 900,
            droneId: 'kestrel-2',
            capturedAt: generatedAt,
        })),
        plan: {
            jobId: 'demo-plan',
            generatedAt,
            horizonMin: 180,
            isochrones: isochrones(),
            track: [0, 60, 120, 180].map((atMin) => ({
                atMin,
                center: at(IGNITION[0] - atMin * 6.6, IGNITION[1] - atMin * 2.2),
                areaHa: atMin * 1.6,
            })),
            headingDeg: HEADING,
            maxSpreadMpm: 16,
            attackZones: attackZones(),
        },
        messages: messages(now),
    };
}
