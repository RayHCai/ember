import {
    Cartesian2,
    ClassificationType,
    Color,
    HeightReference,
    HorizontalOrigin,
    LabelStyle,
    NearFarScalar,
    PolylineArrowMaterialProperty,
    PolylineDashMaterialProperty,
    VerticalOrigin,
    type CustomDataSource,
} from 'cesium';
import type { CivilianArea, PlannerResult, ZoneSurroundings } from '@ember/contracts';
import { useEffect, useMemo } from 'react';
import { circle, distanceM, distinct, spaced } from '../../model/geo';
import type { LatLon } from '../../model/types';
import { ll } from '../../model/zone';
import { minutes } from '../../ui/format';
import { GridOverlay, type CellColor, type OverlayGrid } from '../gridOverlay';
import { ALWAYS_ON_TOP, C, ICONS, LABEL_FONT, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';
import { useMap } from '../viewer';

const M_PER_DEG = 111_320;

function lerp(a: readonly number[], b: readonly number[], t: number): number[] {
    return a.map((v, i) => Math.round(v + (b[i]! - v) * t));
}

/** Soonest is deep red; the far edge of the forecast fades to pale yellow. */
const HEAT = [
    [196, 18, 24],
    [238, 78, 22],
    [248, 160, 30],
    [255, 222, 120],
] as const;

function heat(t: number): number[] {
    const s = Math.min(0.999, Math.max(0, t)) * (HEAT.length - 1);
    const i = Math.floor(s);
    return lerp(HEAT[i]!, HEAT[i + 1]!, s - i);
}

function label(text: string, color: Color = C.ink) {
    return {
        text,
        font: LABEL_FONT,
        fillColor: color,
        showBackground: true,
        backgroundColor: Color.WHITE.withAlpha(0.92),
        backgroundPadding: new Cartesian2(8, 5),
        style: LabelStyle.FILL,
        verticalOrigin: VerticalOrigin.TOP,
        horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, 18),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: ALWAYS_ON_TOP,
        scaleByDistance: new NearFarScalar(8_000, 1, 60_000, 0.7),
    };
}

const ground = {
    clampToGround: true,
    classificationType: ClassificationType.BOTH,
} as const;

function boxAround(
    points: LatLon[],
    cellM: number,
    padM: number,
): OverlayGrid & { dlat: number; dlon: number } {
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const kLon = M_PER_DEG * Math.cos((midLat * Math.PI) / 180);
    const dlat = cellM / M_PER_DEG;
    const dlon = cellM / kLon;
    const south = Math.min(...lats) - padM / M_PER_DEG;
    const west = Math.min(...lons) - padM / kLon;
    const rows = Math.ceil((Math.max(...lats) - south + padM / M_PER_DEG) / dlat) + 1;
    const cols = Math.ceil((Math.max(...lons) - west + padM / kLon) / dlon) + 1;
    return {
        south,
        west,
        north: south + rows * dlat,
        east: west + cols * dlon,
        rows,
        cols,
        dlat,
        dlon,
    };
}

/** How far the civilian gradient reaches around an area. */
function reachM(area: CivilianArea): number {
    const own = area.polygon
        ? Math.max(...area.polygon.map((p) => distanceM(ll(area.center), ll(p))))
        : 0;
    return Math.max(own, Math.min(2500, Math.max(400, Math.sqrt(area.population) * 12)));
}

const ring = (points: LatLon[]) => {
    const path = distinct(points);
    return path.length >= 3 ? [...path, path[0]!].map((p) => toCartesian(p)) : null;
};

function addSpread(ds: CustomDataSource, plan: PlannerResult) {
    const { isochrones, track } = plan.fireSpread;
    // Outermost first, so the widest perimeter keeps its label when they crowd together.
    const outer = [...isochrones].reverse();
    const tops = outer.map((iso) => {
        const first = iso.polygons[0]?.outer ?? [];
        return first.length ? ll(first.reduce((a, b) => (b.lat > a.lat ? b : a))) : null;
    });
    const labelled = spaced(
        tops.map((t) => t ?? [0, 0]),
        150,
    );
    outer.forEach((iso, n) => {
        iso.polygons.forEach((poly, k) => {
            const positions = ring(poly.outer.map(ll));
            if (!positions) return;
            ds.entities.add({
                id: `iso:${iso.atMin}:${k}`,
                polyline: {
                    positions,
                    width: 1.6,
                    ...ground,
                    material: new PolylineDashMaterialProperty({
                        color: C.ink.withAlpha(0.5),
                        dashLength: 12,
                    }),
                },
            });
        });
        const top = tops[n];
        if (!top || !labelled[n]) return;
        ds.entities.add({
            id: `iso-label:${iso.atMin}`,
            position: toCartesian(top),
            label: {
                ...label(`+${minutes(iso.atMin)}`, C.fire),
                pixelOffset: new Cartesian2(0, -6),
                verticalOrigin: VerticalOrigin.BOTTOM,
            },
        });
    });
    const path = distinct(
        track.map((p) => ll(p.center)),
        5,
    );
    if (path.length > 1) {
        ds.entities.add({
            id: 'track',
            polyline: {
                positions: path.map((p) => toCartesian(p)),
                width: 3,
                ...ground,
                material: new PolylineArrowMaterialProperty(C.fire),
            },
        });
    }
}

function addCivilians(ds: CustomDataSource, plan: PlannerResult, areas: Map<string, CivilianArea>) {
    for (const impact of plan.civilianImpacts) {
        const area = areas.get(impact.civilianAreaId);
        if (!area) continue;
        const hit = impact.impactMin !== null;
        const outline = area.polygon ? ring(area.polygon.map(ll)) : null;
        if (outline) {
            ds.entities.add({
                id: `community-outline:${area.id}`,
                polyline: {
                    positions: outline,
                    width: 1.5,
                    ...ground,
                    material: (hit ? C.civilian : C.ink).withAlpha(0.6),
                },
            });
        }
        ds.entities.add({
            id: `community:${area.id}`,
            position: toCartesian(ll(area.center)),
            billboard: {
                image: ICONS.community,
                width: 28,
                height: 28,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: label(
                impact.impactMin === null
                    ? `${area.name} · clear`
                    : impact.impactMin <= 0
                      ? `${area.name} · burning`
                      : `${area.name} · fire in ${minutes(impact.impactMin)}`,
                hit ? C.civilian : C.ink,
            ),
        });
    }
    for (const route of plan.evacuationRoutes) {
        const area = areas.get(route.civilianAreaId);
        const path = distinct(route.path.map(ll));
        if (route.status === 'no_safe_route' || path.length < 2) {
            if (!area) continue;
            ds.entities.add({
                id: `no-route:${route.civilianAreaId}`,
                position: toCartesian(ll(area.center)),
                label: { ...label('No safe route', C.fire), pixelOffset: new Cartesian2(0, 40) },
            });
            continue;
        }
        const positions = path.map((p) => toCartesian(p));
        const color = route.status === 'tight' ? C.risk : C.route;
        ds.entities.add({
            id: `route-halo:${route.civilianAreaId}`,
            polyline: { positions, width: 13, ...ground, material: C.white.withAlpha(0.9) },
        });
        ds.entities.add({
            id: `route:${route.civilianAreaId}`,
            polyline: {
                positions,
                width: 9,
                ...ground,
                material: new PolylineArrowMaterialProperty(color),
            },
        });
        const mid = path[Math.floor(path.length / 2)]!;
        ds.entities.add({
            id: `route-label:${route.civilianAreaId}`,
            position: toCartesian(mid),
            label: {
                ...label(
                    `${(route.distanceM / 1000).toFixed(1)} km · ${Math.round(route.etaMin)} min${route.status === 'tight' ? ' · tight' : ''}`,
                    color,
                ),
                pixelOffset: new Cartesian2(0, 10),
            },
        });
        if (route.destination && route.destination.safeZoneId === null) {
            ds.entities.add({
                id: `exit:${route.civilianAreaId}`,
                position: toCartesian(ll(route.destination.location)),
                point: {
                    pixelSize: 11,
                    color: C.white,
                    outlineColor: C.route,
                    outlineWidth: 3,
                    heightReference: HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: ALWAYS_ON_TOP,
                },
                label: label('Exit', C.route),
            });
        }
    }
}

function addPlaces(ds: CustomDataSource, plan: PlannerResult | null, s: ZoneSurroundings) {
    const used = new Set(plan?.evacuationRoutes.map((r) => r.destination?.safeZoneId) ?? []);
    for (const safe of s.safeZones) {
        if (plan && !used.has(safe.id)) continue;
        ds.entities.add({
            id: `safe:${safe.id}`,
            position: toCartesian(ll(safe.location)),
            billboard: {
                image: ICONS.safe,
                width: 28,
                height: 28,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: label(safe.name, C.route),
        });
    }
    for (const station of s.stations) {
        ds.entities.add({
            id: `station:${station.id}`,
            position: toCartesian(ll(station.location)),
            billboard: {
                image: ICONS.station,
                width: 24,
                height: 24,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
        });
    }
}

function addAttackZones(ds: CustomDataSource, plan: PlannerResult) {
    for (const zone of plan.attackZones) {
        const center = ll(zone.center);
        ds.entities.add({
            id: `drop-fill:${zone.id}`,
            position: toCartesian(center),
            ellipse: {
                semiMajorAxis: zone.radiusM,
                semiMinorAxis: zone.radiusM,
                classificationType: ClassificationType.BOTH,
                material: C.responder.withAlpha(0.16),
            },
        });
        ds.entities.add({
            id: `drop-ring:${zone.id}`,
            polyline: {
                positions: circle(center, zone.radiusM).map((p) => toCartesian(p)),
                width: 2.5,
                ...ground,
                material: new PolylineDashMaterialProperty({ color: C.responder, dashLength: 12 }),
            },
        });
        if (distanceM(center, ll(zone.dropSite)) > 30) {
            ds.entities.add({
                id: `drop-access:${zone.id}`,
                polyline: {
                    positions: [toCartesian(ll(zone.dropSite)), toCartesian(center)],
                    width: 2,
                    ...ground,
                    material: new PolylineDashMaterialProperty({
                        color: C.responder.withAlpha(0.8),
                        dashLength: 6,
                    }),
                },
            });
        }
        ds.entities.add({
            id: `drop:${zone.id}`,
            position: toCartesian(ll(zone.dropSite)),
            billboard: {
                image: ICONS.drop,
                width: 30,
                height: 30,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: label(`#${zone.rank} · ${zone.tactic}`, C.responder),
        });
    }
}

interface Props {
    plan: PlannerResult | null;
    surroundings: ZoneSurroundings | null;
    visible: boolean;
}

/**
 * The planner's answer over the detection map: when fire reaches each cell and its isochrones (the
 * hurricane-style forecast), which civilian areas it reaches first as a gradient, their way out, and
 * where responders should work it.
 */
export function SuggestionsLayer({ plan, surroundings, visible }: Props) {
    const viewer = useMap((s) => s.viewer);
    const ds = useDataSource('suggestions');
    const areas = useMemo(
        () => new Map((surroundings?.civilianAreas ?? []).map((a) => [a.id, a])),
        [surroundings],
    );

    useEffect(() => {
        if (!viewer || !plan || !visible) return;
        const { grid, arrivalMin } = plan.fireSpread;
        if (grid.rows * grid.cols === 0) return;
        const dlat = grid.cellSizeM / M_PER_DEG;
        const midLat = grid.southWest.lat + (grid.rows * dlat) / 2;
        const dlon = grid.cellSizeM / (M_PER_DEG * Math.cos((midLat * Math.PI) / 180));
        const overlay = new GridOverlay(
            viewer,
            {
                south: grid.southWest.lat,
                west: grid.southWest.lng,
                north: grid.southWest.lat + grid.rows * dlat,
                east: grid.southWest.lng + grid.cols * dlon,
                rows: grid.rows,
                cols: grid.cols,
            },
            2,
            true,
        );
        overlay.paint((i): CellColor => {
            const m = arrivalMin[i];
            if (m === null || m === undefined) return null;
            const t = Math.max(0, m) / plan.horizonMin;
            const [r, g, b] = heat(t);
            return [r!, g!, b!, Math.round(205 - 150 * t)];
        });
        return () => overlay.destroy();
    }, [viewer, plan, visible]);

    useEffect(() => {
        if (!viewer || !plan || !visible) return;
        const hit = plan.civilianImpacts
            .filter((c) => c.gradient > 0)
            .map((c) => ({ impact: c, area: areas.get(c.civilianAreaId) }))
            .filter((x): x is { impact: typeof x.impact; area: CivilianArea } => Boolean(x.area));
        if (hit.length === 0) return;
        const reaches = hit.map((x) => reachM(x.area));
        const g = boxAround(
            hit.map((x) => ll(x.area.center)),
            60,
            Math.max(...reaches),
        );
        const overlay = new GridOverlay(viewer, g, 3, true);
        const low = [247, 174, 248];
        const high = [181, 23, 158];
        overlay.paint((i): CellColor => {
            const at: LatLon = [
                g.south + (Math.floor(i / g.cols) + 0.5) * g.dlat,
                g.west + ((i % g.cols) + 0.5) * g.dlon,
            ];
            let best = 0;
            hit.forEach(({ impact, area }, k) => {
                const d = distanceM(at, ll(area.center));
                const R = reaches[k]!;
                if (d < R) best = Math.max(best, impact.gradient * (1 - d / R) ** 1.4);
            });
            if (best < 0.02) return null;
            const [r, gg, b] = lerp(low, high, Math.min(1, best * 1.1));
            return [r!, gg!, b!, Math.round(40 + 175 * Math.min(1, best * 1.2))];
        });
        return () => overlay.destroy();
    }, [viewer, plan, areas, visible]);

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        if (!visible) return;
        if (plan) {
            addSpread(ds, plan);
            addCivilians(ds, plan, areas);
            addAttackZones(ds, plan);
        }
        if (surroundings) addPlaces(ds, plan, surroundings);
    }, [ds, plan, surroundings, areas, visible]);

    return null;
}
