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
import { useEffect, useMemo } from 'react';
import { circle, distanceM, offset } from '../../sim/geo';
import type {
    CivilianPlan,
    LatLon,
    ResponderPlan,
    SafeZone,
    SpreadForecast,
} from '../../sim/types';
import { GridOverlay, type CellColor } from '../gridOverlay';
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

function overlayGrid(points: LatLon[], cellM: number, padM: number) {
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const dlat = cellM / M_PER_DEG;
    const dlon = cellM / (M_PER_DEG * Math.cos((midLat * Math.PI) / 180));
    const south = Math.min(...lats) - padM / M_PER_DEG;
    const west = Math.min(...lons) - padM / M_PER_DEG / Math.cos((midLat * Math.PI) / 180);
    const rows = Math.ceil((Math.max(...lats) - south) / dlat + padM / cellM) + 1;
    const cols = Math.ceil((Math.max(...lons) - west) / dlon + padM / cellM) + 1;
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

function hours(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

function trackLabel(atMin: number): string {
    return atMin % 60 === 0 ? `+${atMin / 60}h` : `+${hours(atMin)}`;
}

/** Predicted perimeters as thin fire-colored contours over the arrival gradient. */
function addIsochrones(ds: CustomDataSource, spread: SpreadForecast) {
    for (const iso of spread.isochrones ?? []) {
        iso.rings.forEach((ring, k) => {
            if (ring.length < 3) return;
            ds.entities.add({
                id: `isochrone:${iso.atMin}:${k}`,
                polyline: {
                    positions: [...ring, ring[0]!].map((p) => toCartesian(p)),
                    width: 1.5,
                    clampToGround: true,
                    classificationType: ClassificationType.BOTH,
                    material: C.fire.withAlpha(0.6),
                },
            });
        });
    }
}

/** The forecast's hurricane-style cone: widening uncertainty around the head's track. */
function addCone(ds: CustomDataSource, spread: SpreadForecast) {
    const theta = (spread.headingDeg * Math.PI) / 180;
    const side = (at: LatLon, r: number, sign: number) =>
        offset(at, -Math.sin(theta) * r * sign, Math.cos(theta) * r * sign);
    const left = spread.track.map((p) => side(p.at, p.radiusM, 1));
    const right = spread.track.map((p) => side(p.at, p.radiusM, -1)).reverse();
    const last = spread.track[spread.track.length - 1]!;
    // From the left flank, round the front of the cone, to the right flank.
    const cap = Array.from({ length: 13 }, (_, i) => {
        const b = theta + Math.PI / 2 - (i / 12) * Math.PI;
        return offset(last.at, Math.cos(b) * last.radiusM, Math.sin(b) * last.radiusM);
    });
    const outline = [...left, ...cap, ...right, left[0]!].map((p) => toCartesian(p));
    ds.entities.add({
        id: 'cone',
        polyline: {
            positions: outline,
            width: 2,
            clampToGround: true,
            classificationType: ClassificationType.BOTH,
            material: new PolylineDashMaterialProperty({
                color: C.ink.withAlpha(0.55),
                dashLength: 14,
            }),
        },
    });
    ds.entities.add({
        id: 'track',
        polyline: {
            positions: spread.track.map((p) => toCartesian(p.at)),
            width: 3,
            clampToGround: true,
            classificationType: ClassificationType.BOTH,
            material: new PolylineDashMaterialProperty({ color: C.fire, dashLength: 10 }),
        },
    });
    spread.track.slice(1).forEach((p) => {
        ds.entities.add({
            id: `track:${p.atMin}`,
            position: toCartesian(p.at),
            point: {
                pixelSize: 9,
                color: C.white,
                outlineColor: C.fire,
                outlineWidth: 3,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: { ...label(trackLabel(p.atMin), C.fire), pixelOffset: new Cartesian2(0, 12) },
        });
    });
}

function addRoutes(ds: CustomDataSource, plan: CivilianPlan, safeZones: SafeZone[]) {
    for (const route of plan.routes) {
        if (route.alternate) {
            ds.entities.add({
                id: `route-alt:${route.id}`,
                polyline: {
                    positions: route.alternate.map((p) => toCartesian(p)),
                    width: 4,
                    clampToGround: true,
                    classificationType: ClassificationType.BOTH,
                    material: new PolylineDashMaterialProperty({
                        color: C.route,
                        gapColor: C.white.withAlpha(0.7),
                        dashLength: 12,
                    }),
                },
            });
        }
        const positions = route.path.map((p) => toCartesian(p));
        ds.entities.add({
            id: `route-halo:${route.id}`,
            polyline: {
                positions,
                width: 13,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: C.white.withAlpha(0.9),
            },
        });
        ds.entities.add({
            id: `route:${route.id}`,
            polyline: {
                positions,
                width: 9,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: new PolylineArrowMaterialProperty(C.route),
            },
        });
        const mid = route.path[Math.floor(route.path.length / 2)]!;
        ds.entities.add({
            id: `route-label:${route.id}`,
            position: toCartesian(mid),
            label: {
                ...label(`${route.name} · ${route.distanceKm} km · ${route.etaMin} min`, C.route),
                pixelOffset: new Cartesian2(0, 10),
            },
        });
    }
    const used = new Set(plan.routes.map((r) => r.safeZoneId));
    for (const safe of safeZones) {
        ds.entities.add({
            id: `safe:${safe.id}`,
            position: toCartesian([safe.lat, safe.lon]),
            billboard: {
                image: ICONS.safe,
                width: used.has(safe.id) ? 30 : 24,
                height: used.has(safe.id) ? 30 : 24,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: label(safe.name, C.route),
        });
    }
}

function addCommunities(ds: CustomDataSource, plan: CivilianPlan) {
    for (const c of plan.impacts) {
        ds.entities.add({
            id: `community:${c.communityId}`,
            position: toCartesian([c.lat, c.lon]),
            billboard: {
                image: ICONS.community,
                width: 28,
                height: 28,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: label(
                c.arrivalMin === null
                    ? `${c.name} · clear`
                    : `${c.name} · fire in ${hours(c.arrivalMin)}`,
                c.arrivalMin === null ? C.ink : C.civilian,
            ),
        });
    }
}

function addDropSites(ds: CustomDataSource, plan: ResponderPlan) {
    for (const site of plan.dropSites) {
        const center = toCartesian([site.lat, site.lon]);
        ds.entities.add({
            id: `drop-fill:${site.id}`,
            position: center,
            ellipse: {
                semiMajorAxis: site.radiusM,
                semiMinorAxis: site.radiusM,
                classificationType: ClassificationType.BOTH,
                material: C.responder.withAlpha(0.16),
            },
        });
        ds.entities.add({
            id: `drop-ring:${site.id}`,
            polyline: {
                positions: circle([site.lat, site.lon], site.radiusM).map((p) => toCartesian(p)),
                width: 2.5,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: new PolylineDashMaterialProperty({ color: C.responder, dashLength: 12 }),
            },
        });
        ds.entities.add({
            id: `drop:${site.id}`,
            position: center,
            billboard: {
                image: ICONS.drop,
                width: 30,
                height: 30,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: ALWAYS_ON_TOP,
            },
            label: label(site.name, C.responder),
        });
    }
}

interface Props {
    civilian: CivilianPlan | null;
    responder: ResponderPlan | null;
    safeZones: SafeZone[];
    visible: boolean;
}

/**
 * Planner suggestions over the detection map: where the fire is predicted to run, which
 * civilians it reaches first, the way out for them, and where responders should stage.
 */
export function SuggestionsLayer({ civilian, responder, safeZones, visible }: Props) {
    const viewer = useMap((s) => s.viewer);
    const ds = useDataSource('suggestions');
    const spread = civilian?.spread ?? responder?.spread ?? null;

    const spreadGrid = useMemo(() => {
        if (!spread || spread.cells.length === 0) return null;
        const g = overlayGrid(
            spread.cells.map(([lat, lon]) => [lat, lon]),
            spread.cellM,
            spread.cellM,
        );
        const arrival = new Float32Array(g.rows * g.cols).fill(Number.POSITIVE_INFINITY);
        for (const [lat, lon, m] of spread.cells) {
            // Cells sit on bin edges; the half step keeps float noise from skipping a bin.
            const row = Math.floor((lat - g.south) / g.dlat + 0.5);
            const col = Math.floor((lon - g.west) / g.dlon + 0.5);
            if (row >= 0 && row < g.rows && col >= 0 && col < g.cols)
                arrival[row * g.cols + col] = m;
        }
        return { g, arrival };
    }, [spread]);

    useEffect(() => {
        if (!viewer || !spreadGrid || !visible || !spread) return;
        const overlay = new GridOverlay(viewer, spreadGrid.g, 3, true);
        overlay.paint((i): CellColor => {
            const m = spreadGrid.arrival[i]!;
            if (!Number.isFinite(m)) return null;
            const t = m / spread.horizonMin;
            const [r, g, b] = heat(t);
            return [r!, g!, b!, Math.round(205 - 150 * t)];
        });
        return () => overlay.destroy();
    }, [viewer, spreadGrid, spread, visible]);

    useEffect(() => {
        if (!viewer || !civilian || !visible) return;
        const impacted = civilian.impacts.filter((c) => c.urgency > 0);
        if (impacted.length === 0) return;
        const radius = (u: number) => 1400 + 1300 * u;
        const g = overlayGrid(
            impacted.map((c) => [c.lat, c.lon] as LatLon),
            110,
            radius(1),
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
            for (const c of impacted) {
                const d = distanceM(at, [c.lat, c.lon]);
                const R = radius(c.urgency);
                if (d < R) best = Math.max(best, c.urgency * (1 - d / R) ** 1.4);
            }
            if (best < 0.02) return null;
            const [r, gg, b] = lerp(low, high, Math.min(1, best * 1.1));
            return [r!, gg!, b!, Math.round(40 + 175 * Math.min(1, best * 1.2))];
        });
        return () => overlay.destroy();
    }, [viewer, civilian, visible]);

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        if (!visible) return;
        if (spread) addIsochrones(ds, spread);
        if (spread && spread.track.length > 0) addCone(ds, spread);
        if (civilian) {
            addRoutes(ds, civilian, safeZones);
            addCommunities(ds, civilian);
        }
        if (responder) addDropSites(ds, responder);
    }, [ds, spread, civilian, responder, safeZones, visible]);

    return null;
}
