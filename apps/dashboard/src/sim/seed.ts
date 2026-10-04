import { civilianPlan, responderPlan } from './planners';
import type { EdgeServer, WatchZone } from './types';
import { buildZone, mapEverything, pairDrone, seeded, suggestServers } from './world';

// The console's starting dummy data: five watch zones at different stages.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The suggested layout, already deployed; `drop` leaves off the last few to leave gaps. */
function deployAll(zone: WatchZone, drop = 0): EdgeServer[] {
    const suggested = suggestServers(zone);
    return suggested
        .slice(0, Math.max(2, suggested.length - drop))
        .map((s) => ({ ...s, status: 'deployed' as const }));
}

function withDrones(zone: WatchZone, perServer: number, rand: () => number): void {
    for (const server of zone.servers) {
        if (server.status !== 'deployed') continue;
        for (let k = 0; k < perServer; k++) {
            const drone = pairDrone(zone, server, rand);
            zone.drones.push({ ...drone, pairedAt: Date.now() - (40 + rand() * 400) * HOUR });
        }
    }
}

function angeles(now: number): WatchZone {
    const rand = seeded(11);
    const zone = buildZone({
        id: 'angeles-foothills',
        name: 'Angeles foothills',
        region: 'Angeles National Forest, CA',
        createdAt: now - 21 * 24 * HOUR,
        boundary: [
            [34.2155, -118.092],
            [34.2205, -118.066],
            [34.219, -118.036],
            [34.206, -118.017],
            [34.188, -118.02],
            [34.1745, -118.031],
            [34.1712, -118.058],
            [34.173, -118.084],
            [34.195, -118.095],
        ],
        hazards: [
            { at: [34.1885, -118.0565], kind: 'fire', radiusM: 360 },
            { at: [34.205, -118.083], kind: 'risk', radiusM: 430 },
            { at: [34.179, -118.033], kind: 'risk', radiusM: 320 },
        ],
        windFromDeg: 12,
        communities: [
            {
                id: 'c-sierra-madre',
                name: 'Sierra Madre',
                lat: 34.1617,
                lon: -118.0528,
                population: 10900,
            },
            { id: 'c-arcadia', name: 'Arcadia', lat: 34.1397, lon: -118.0353, population: 56000 },
            { id: 'c-altadena', name: 'Altadena', lat: 34.1897, lon: -118.1312, population: 42800 },
            { id: 'c-bradbury', name: 'Bradbury', lat: 34.1469, lon: -117.9706, population: 900 },
        ],
        safeZones: [
            { id: 's-arcadia-hs', name: 'Arcadia High School', lat: 34.1285, lon: -118.0467 },
            { id: 's-eaton', name: 'Eaton Canyon hall', lat: 34.158, lon: -118.115 },
            { id: 's-monrovia', name: 'Monrovia Sports Park', lat: 34.137, lon: -117.992 },
        ],
    });
    zone.servers = deployAll(zone);
    withDrones(zone, 2, rand);
    mapEverything(zone);
    zone.lastScanAt = now - 2 * HOUR - 10 * MIN;
    zone.schedule = { enabled: true, everyHours: 6, nextAt: now + 3 * HOUR + 50 * MIN };
    zone.civilianPlan = { ...civilianPlan(zone), generatedAt: now - 96 * MIN };
    zone.responderPlan = { ...responderPlan(zone), generatedAt: now - 94 * MIN };
    zone.checkIns = { safe: 128, total: 342 };
    zone.reports = [
        {
            id: 'rep-1',
            from: '+1 (626) 555-0148',
            text: 'Lots of smoke over the Chantry Flat trailhead, photo attached',
            lat: 34.1905,
            lon: -118.0452,
            receivedAt: now - 38 * MIN,
            status: 'new',
        },
        {
            id: 'rep-2',
            from: '+1 (626) 555-0119',
            text: 'Ash falling on Mira Monte. Is my street at risk?',
            lat: 34.1708,
            lon: -118.0612,
            receivedAt: now - 21 * MIN,
            status: 'new',
        },
    ];
    zone.responders = [
        {
            id: 'r-1',
            name: 'Capt. Dana Ruiz',
            unit: 'Engine 41',
            device: 'iPhone 15',
            joinedAt: now - 30 * HOUR,
        },
        {
            id: 'r-2',
            name: 'Lee Okafor',
            unit: 'Hand crew 7',
            device: 'Pixel 8',
            joinedAt: now - 9 * HOUR,
        },
        {
            id: 'r-3',
            name: 'Sam Whitfield',
            unit: 'Air attack 2',
            device: 'iPad mini',
            joinedAt: now - 3 * HOUR,
        },
    ];
    zone.blasts = [
        {
            id: 'bl-1',
            audience: 'responders',
            priority: 'urgent',
            title: 'Spot fire confirmed',
            body: 'Drone confirmed active fire 2.9 km north of Sierra Madre. Stage at Chantry Flat Rd.',
            area: 'zone',
            recipients: { civilians: 0, responders: 3 },
            sentAt: now - 90 * MIN,
            approval: null,
        },
    ];
    return zone;
}

function santaCruz(now: number): WatchZone {
    const rand = seeded(23);
    const zone = buildZone({
        id: 'santa-cruz-mountains',
        name: 'Santa Cruz Mountains',
        region: 'Santa Cruz County, CA',
        createdAt: now - 48 * 24 * HOUR,
        boundary: [
            [37.192, -122.178],
            [37.198, -122.15],
            [37.188, -122.122],
            [37.166, -122.116],
            [37.149, -122.131],
            [37.146, -122.16],
            [37.163, -122.182],
        ],
        hazards: [],
        windFromDeg: 300,
    });
    zone.servers = deployAll(zone);
    withDrones(zone, 2, rand);
    mapEverything(zone);
    zone.lastScanAt = now - 5 * HOUR - 24 * MIN;
    zone.schedule = { enabled: true, everyHours: 12, nextAt: now + 6 * HOUR + 36 * MIN };
    zone.responders = [
        {
            id: 'r-4',
            name: 'Jordan Pike',
            unit: 'CAL FIRE CZU',
            device: 'iPhone 14',
            joinedAt: now - 70 * HOUR,
        },
    ];
    return zone;
}

function boulder(now: number): WatchZone {
    const rand = seeded(37);
    const zone = buildZone({
        id: 'boulder-foothills',
        name: 'Boulder foothills',
        region: 'Boulder County, CO',
        createdAt: now - 9 * 24 * HOUR,
        boundary: [
            [40.022, -105.338],
            [40.026, -105.305],
            [40.012, -105.288],
            [39.99, -105.292],
            [39.978, -105.312],
            [39.982, -105.338],
            [40.002, -105.35],
        ],
        hazards: [
            { at: [40.008, -105.33], kind: 'risk', radiusM: 520 },
            { at: [39.99, -105.305], kind: 'risk', radiusM: 380 },
        ],
        windFromDeg: 280,
    });
    zone.servers = deployAll(zone, 2);
    withDrones(zone, 2, rand);
    mapEverything(zone);
    zone.lastScanAt = now - 26 * HOUR;
    zone.schedule = { enabled: false, everyHours: 24, nextAt: null };
    return zone;
}

function sequoia(now: number): WatchZone {
    const zone = buildZone({
        id: 'giant-forest',
        name: 'Giant Forest',
        region: 'Sequoia National Park, CA',
        createdAt: now - 2 * 24 * HOUR,
        boundary: [
            [36.585, -118.79],
            [36.588, -118.758],
            [36.572, -118.742],
            [36.552, -118.748],
            [36.546, -118.775],
            [36.562, -118.795],
        ],
        windFromDeg: 220,
    });
    zone.servers = deployAll(zone);
    return zone;
}

function huron(now: number): WatchZone {
    return buildZone({
        id: 'huron-manistee',
        name: 'Huron-Manistee',
        region: 'Huron-Manistee National Forests, MI',
        createdAt: now - 3 * HOUR,
        boundary: [
            [44.452, -85.905],
            [44.455, -85.87],
            [44.44, -85.85],
            [44.418, -85.856],
            [44.41, -85.884],
            [44.425, -85.906],
        ],
        windFromDeg: 250,
    });
}

export function seedZones(now = Date.now()): WatchZone[] {
    return [angeles(now), santaCruz(now), boulder(now), sequoia(now), huron(now)];
}
