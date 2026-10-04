import type { LatLng } from '@ember/contracts';

export type Ring = LatLng[];

export type OsmElement = {
    type: 'node' | 'way' | 'relation';
    id: number;
    tags: Record<string, string>;
    /** A node's position, or the centre Overpass computed for a way or relation. */
    point: LatLng | null;
    /** A way's outline. */
    geometry: LatLng[];
    /** A relation's member ways. */
    members: { role: string; geometry: LatLng[] }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

function toPoint(value: unknown): LatLng | null {
    return isRecord(value) && isNumber(value.lat) && isNumber(value.lon)
        ? { lat: value.lat, lng: value.lon }
        : null;
}

function toPath(value: unknown): LatLng[] {
    if (!Array.isArray(value)) return [];
    const path: LatLng[] = [];
    for (const item of value) {
        const point = toPoint(item);
        if (point) path.push(point);
    }
    return path;
}

function toTags(value: unknown): Record<string, string> {
    const tags: Record<string, string> = {};
    if (!isRecord(value)) return tags;
    for (const [key, tag] of Object.entries(value)) {
        if (typeof tag === 'string') tags[key] = tag;
    }
    return tags;
}

/** Skips anything that is not a node, way or relation with a numeric id. */
export function parseElements(elements: readonly unknown[]): OsmElement[] {
    const parsed: OsmElement[] = [];
    for (const raw of elements) {
        if (!isRecord(raw) || !isNumber(raw.id)) continue;
        const type = raw.type;
        if (type !== 'node' && type !== 'way' && type !== 'relation') continue;
        const members: OsmElement['members'] = [];
        if (type === 'relation' && Array.isArray(raw.members)) {
            for (const member of raw.members) {
                if (!isRecord(member) || member.type !== 'way') continue;
                const role = typeof member.role === 'string' ? member.role : '';
                members.push({ role, geometry: toPath(member.geometry) });
            }
        }
        parsed.push({
            type,
            id: raw.id,
            tags: toTags(raw.tags),
            point: type === 'node' ? toPoint(raw) : toPoint(raw.center),
            geometry: type === 'way' ? toPath(raw.geometry) : [],
            members,
        });
    }
    return parsed;
}

const keyOf = (at: LatLng) => `${at.lat.toFixed(7)},${at.lng.toFixed(7)}`;

type Segment = { points: LatLng[]; from: string; to: string };

function toSegment(points: LatLng[]): Segment | null {
    const first = points[0];
    const last = points[points.length - 1];
    return first && last ? { points, from: keyOf(first), to: keyOf(last) } : null;
}

function closedRing(points: readonly LatLng[]): Ring | null {
    const ring = points.slice(0, -1);
    return ring.length >= 3 ? ring : null;
}

/**
 * Joins ways end to end into closed rings. Members arrive split and in either direction; chains
 * that never close are dropped. Rings come back without the repeated first point.
 */
export function assembleRings(paths: readonly LatLng[][]): Ring[] {
    const rings: Ring[] = [];
    const open: Segment[] = [];
    for (const path of paths) {
        const segment = toSegment(path);
        if (!segment) continue;
        if (segment.from !== segment.to) {
            open.push(segment);
            continue;
        }
        const ring = closedRing(path);
        if (ring) rings.push(ring);
    }

    const byEnd = new Map<string, number[]>();
    open.forEach((segment, index) => {
        for (const end of [segment.from, segment.to]) {
            byEnd.set(end, [...(byEnd.get(end) ?? []), index]);
        }
    });

    const used = new Set<number>();
    open.forEach((start, startIndex) => {
        if (used.has(startIndex)) return;
        used.add(startIndex);
        const chain = [...start.points];
        let tail = start.to;
        while (tail !== start.from) {
            const nextIndex = (byEnd.get(tail) ?? []).find((index) => !used.has(index));
            const next = nextIndex === undefined ? undefined : open[nextIndex];
            if (nextIndex === undefined || !next) break;
            used.add(nextIndex);
            const forward = next.from === tail;
            const points = forward ? next.points : next.points.toReversed();
            for (let k = 1; k < points.length; k++) {
                const at = points[k];
                if (at) chain.push(at);
            }
            tail = forward ? next.to : next.from;
        }
        if (tail !== start.from) return;
        const ring = closedRing(chain);
        if (ring) rings.push(ring);
    });
    return rings;
}

export type ElementRings = { outer: Ring[]; inner: Ring[] };

/** A closed way is one ring; a multipolygon relation's members are assembled into rings. */
export function elementRings(element: OsmElement): ElementRings {
    if (element.type === 'way') {
        return { outer: assembleRings([element.geometry]), inner: [] };
    }
    if (element.type === 'relation') {
        const outer = element.members.filter((m) => m.role !== 'inner').map((m) => m.geometry);
        const inner = element.members.filter((m) => m.role === 'inner').map((m) => m.geometry);
        return { outer: assembleRings(outer), inner: assembleRings(inner) };
    }
    return { outer: [], inner: [] };
}
