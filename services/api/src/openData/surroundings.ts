import type {
    CivilianArea,
    LatLng,
    ResponderStation,
    Road,
    RoadKind,
    SafeZone,
} from '@ember/contracts';
import { areaM2, boundsOf, centroid, contains, distanceM, growBounds, inBounds } from './geo.js';
import type { Bounds } from './geo.js';
import { elementRings } from './osm.js';
import type { OsmElement } from './osm.js';
import type { Overpass } from './overpass.js';
import type { FetchedSurroundings, OpenData } from './types.js';

const AREA_MARGIN_M = 4000;
const STATION_MARGIN_M = 12000;
const MAX_CIVILIAN_AREAS = 60;
const MAX_ROADS = 6000;
const MAX_SAFE_ZONES = 40;
const MAX_STATIONS = 30;

const PLACE_POPULATION = new Map([
    ['city', 50000],
    ['town', 8000],
    ['suburb', 5000],
    ['village', 1500],
    ['neighbourhood', 1500],
    ['quarter', 1000],
    ['hamlet', 150],
    ['isolated_dwelling', 10],
]);

const ROAD_KIND = new Map<string, RoadKind>([
    ['motorway', 'motorway'],
    ['motorway_link', 'motorway'],
    ['trunk', 'primary'],
    ['trunk_link', 'primary'],
    ['primary', 'primary'],
    ['primary_link', 'primary'],
    ['secondary', 'secondary'],
    ['secondary_link', 'secondary'],
    ['tertiary', 'secondary'],
    ['tertiary_link', 'secondary'],
    ['unclassified', 'secondary'],
    ['residential', 'residential'],
    ['track', 'track'],
]);
const ROAD_RANK: Record<RoadKind, number> = {
    motorway: 0,
    primary: 1,
    secondary: 2,
    residential: 3,
    track: 4,
};

const SAFE_AMENITY = new Map([
    ['school', 'School'],
    ['college', 'College'],
    ['university', 'University'],
    ['hospital', 'Hospital'],
    ['community_centre', 'Community centre'],
    ['townhall', 'Town hall'],
    ['shelter', 'Shelter'],
]);
const STATION_AMENITY = new Map([
    ['fire_station', 'Fire station'],
    ['ranger_station', 'Ranger station'],
]);

const bbox = (b: Bounds) =>
    `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
const anyOf = (values: Iterable<string>) => `^(${[...values].join('|')})$`;

function surroundingsQuery(area: Bounds, wide: Bounds): string {
    return [
        '(',
        `  way["highway"~"${anyOf(ROAD_KIND.keys())}"]${bbox(area)};`,
        ');',
        'out geom;',
        '(',
        `  node["place"~"${anyOf(PLACE_POPULATION.keys())}"]["name"]${bbox(area)};`,
        `  way["landuse"="residential"]${bbox(area)};`,
        `  relation["landuse"="residential"]${bbox(area)};`,
        ');',
        'out geom;',
        '(',
        `  nwr["amenity"~"${anyOf(SAFE_AMENITY.keys())}"]${bbox(area)};`,
        `  nwr["emergency"="assembly_point"]${bbox(area)};`,
        `  nwr["social_facility"="shelter"]${bbox(area)};`,
        `  nwr["amenity"~"${anyOf(STATION_AMENITY.keys())}"]${bbox(wide)};`,
        ');',
        'out center;',
    ].join('\n');
}

function numeric(tag: string | undefined): number | null {
    const text = tag?.replace(/[\s,]/g, '');
    if (!text || !/^\d+$/.test(text)) return null;
    const value = Number(text);
    return value > 0 ? value : null;
}

function civilianAreas(elements: readonly OsmElement[]): CivilianArea[] {
    const residential = elements
        .filter((e) => e.type !== 'node' && e.tags.landuse === 'residential')
        .flatMap((e) => elementRings(e).outer)
        .map((ring) => ({ ring, bounds: boundsOf(ring) }));

    const areas: CivilianArea[] = [];
    for (const element of elements) {
        const { place, name } = element.tags;
        const fallback = place === undefined ? undefined : PLACE_POPULATION.get(place);
        if (element.type !== 'node' || !element.point || !name || fallback === undefined) continue;
        const centre = element.point;
        let polygon: LatLng[] | null = null;
        let smallest = Infinity;
        for (const candidate of residential) {
            if (!inBounds(candidate.bounds, centre) || !contains(candidate.ring, centre)) continue;
            const size = areaM2(candidate.ring);
            if (size < smallest) {
                smallest = size;
                polygon = candidate.ring;
            }
        }
        areas.push({
            id: `osm-node-${element.id}`,
            name,
            center: centre,
            polygon,
            population: numeric(element.tags.population) ?? fallback,
        });
    }
    return areas
        .toSorted((a, b) => b.population - a.population || a.name.localeCompare(b.name))
        .slice(0, MAX_CIVILIAN_AREAS);
}

function roads(elements: readonly OsmElement[]): Road[] {
    const found: { road: Road; rank: number }[] = [];
    for (const element of elements) {
        const highway = element.tags.highway;
        const kind = element.type === 'way' && highway ? ROAD_KIND.get(highway) : undefined;
        if (!kind || element.geometry.length < 2) continue;
        found.push({
            road: {
                id: `osm-way-${element.id}`,
                name: element.tags.name ?? null,
                kind,
                path: element.geometry,
            },
            rank: ROAD_RANK[kind],
        });
    }
    return found
        .toSorted((a, b) => a.rank - b.rank)
        .slice(0, MAX_ROADS)
        .map((entry) => entry.road);
}

function safeZoneLabel(
    tags: Record<string, string>,
): { label: string; sheltering: boolean } | null {
    if (tags.emergency === 'assembly_point') return { label: 'Assembly point', sheltering: true };
    if (tags.social_facility === 'shelter') return { label: 'Shelter', sheltering: true };
    const label = tags.amenity === undefined ? undefined : SAFE_AMENITY.get(tags.amenity);
    return label === undefined ? null : { label, sheltering: tags.amenity === 'shelter' };
}

function safeZones(
    elements: readonly OsmElement[],
    boundary: readonly LatLng[],
    from: LatLng,
): SafeZone[] {
    const found: { zone: SafeZone; group: number; distance: number }[] = [];
    for (const element of elements) {
        const kind = safeZoneLabel(element.tags);
        const location = element.point;
        if (!kind || !location || contains(boundary, location)) continue;
        const name = element.tags.name;
        found.push({
            zone: {
                id: `osm-${element.type}-${element.id}`,
                name: name || kind.label,
                location,
                capacity: numeric(element.tags.capacity),
            },
            // Assembly points and shelters first, then named places, then the rest.
            group: kind.sheltering ? 0 : name ? 1 : 2,
            distance: distanceM(from, location),
        });
    }
    return found
        .toSorted((a, b) => a.group - b.group || a.distance - b.distance)
        .slice(0, MAX_SAFE_ZONES)
        .map((entry) => entry.zone);
}

function stations(elements: readonly OsmElement[], from: LatLng): ResponderStation[] {
    const found: { station: ResponderStation; distance: number }[] = [];
    for (const element of elements) {
        const label =
            element.tags.amenity === undefined
                ? undefined
                : STATION_AMENITY.get(element.tags.amenity);
        const location = element.point;
        if (label === undefined || !location) continue;
        found.push({
            station: {
                id: `osm-${element.type}-${element.id}`,
                name: element.tags.name || label,
                location,
            },
            distance: distanceM(from, location),
        });
    }
    return found
        .toSorted((a, b) => a.distance - b.distance)
        .slice(0, MAX_STATIONS)
        .map((entry) => entry.station);
}

export function createSurroundings(overpass: Overpass): OpenData['surroundings'] {
    return async (boundary): Promise<FetchedSurroundings> => {
        const drawn = boundsOf(boundary);
        const elements = await overpass(
            surroundingsQuery(
                growBounds(drawn, AREA_MARGIN_M),
                growBounds(drawn, STATION_MARGIN_M),
            ),
        );
        const middle = centroid(boundary);
        return {
            source: 'openstreetmap',
            civilianAreas: civilianAreas(elements),
            roads: roads(elements),
            safeZones: safeZones(elements, boundary, middle),
            stations: stations(elements, middle),
        };
    };
}
