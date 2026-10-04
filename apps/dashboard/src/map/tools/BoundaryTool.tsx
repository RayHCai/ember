import {
    CallbackProperty,
    ClassificationType,
    ColorMaterialProperty,
    ConstantPositionProperty,
    HeightReference,
    PolygonHierarchy,
    PolylineDashMaterialProperty,
    type Cartesian3,
} from 'cesium';
import { useEffect, useRef } from 'react';
import type { LatLon } from '../../sim/types';
import { useMapInput } from '../input';
import { ALWAYS_ON_TOP, C, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';

const VERTEX = 'vertex:';
const MIDPOINT = 'mid:';

function indexOf(id: string, prefix: string): number | null {
    return id.startsWith(prefix) ? Number(id.slice(prefix.length)) : null;
}

function midpoint(a: LatLon, b: LatLon): LatLon {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

interface Props {
    points: LatLon[];
    closed: boolean;
    active: boolean;
    onChange: (points: LatLon[], closed: boolean) => void;
}

/**
 * Draws a watch zone boundary: click to drop points, each joined to the last by a thin
 * line; click the first point (or press Enter) to close and fill it. Drag points to
 * adjust, drag or click a midpoint to add a point, right-click a point to remove it.
 */
export function BoundaryTool({ points, closed, active, onChange }: Props) {
    const ds = useDataSource('boundary-tool');
    const state = useRef({ points, closed });
    state.current = { points, closed };
    const cursor = useRef<LatLon | null>(null);
    const addedAt = useRef(0);
    const change = useRef(onChange);
    change.current = onChange;

    useEffect(() => {
        if (!ds) return;
        const positions = (): Cartesian3[] => state.current.points.map((p) => toCartesian(p));
        ds.entities.add({
            id: 'draft-fill',
            polygon: {
                hierarchy: new CallbackProperty(() => {
                    const pts = positions();
                    return state.current.closed && pts.length >= 3
                        ? new PolygonHierarchy(pts)
                        : undefined;
                }, false),
                material: new ColorMaterialProperty(C.boundary.withAlpha(0.2)),
                classificationType: ClassificationType.BOTH,
            },
        });
        ds.entities.add({
            id: 'draft-edges',
            polyline: {
                positions: new CallbackProperty(() => {
                    const pts = positions();
                    return state.current.closed && pts.length >= 3 ? [...pts, pts[0]!] : pts;
                }, false),
                width: 1.6,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: C.boundary,
            },
        });
        ds.entities.add({
            id: 'draft-next',
            polyline: {
                positions: new CallbackProperty(() => {
                    const { points: pts, closed: done } = state.current;
                    if (done || pts.length === 0 || !cursor.current) return [];
                    return [toCartesian(pts[pts.length - 1]!), toCartesian(cursor.current)];
                }, false),
                width: 1.4,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: new PolylineDashMaterialProperty({
                    color: C.boundary.withAlpha(0.75),
                    dashLength: 9,
                }),
            },
        });
        return () => ds.entities.removeAll();
    }, [ds]);

    useEffect(() => {
        if (!ds) return;
        const canClose = !closed && points.length >= 3;
        const want = new Set<string>();
        points.forEach((p, i) => {
            const id = `${VERTEX}${i}`;
            want.add(id);
            const last = i === points.length - 1;
            const size = i === 0 && canClose ? 15 : 10;
            const existing = ds.entities.getById(id);
            if (existing?.point) {
                existing.position = new ConstantPositionProperty(toCartesian(p));
                existing.point.pixelSize = (
                    last && !closed
                        ? new CallbackProperty(
                              () =>
                                  size *
                                  Math.min(1, 0.3 + (performance.now() - addedAt.current) / 220),
                              false,
                          )
                        : size
                ) as never;
                existing.point.outlineColor = (
                    i === 0 && canClose ? C.boundary.withAlpha(0.35) : C.white
                ) as never;
                existing.point.outlineWidth = (i === 0 && canClose ? 6 : 2.5) as never;
            } else {
                ds.entities.add({
                    id,
                    position: toCartesian(p),
                    point: {
                        pixelSize: size,
                        color: C.boundary,
                        outlineColor: C.white,
                        outlineWidth: 2.5,
                        heightReference: HeightReference.CLAMP_TO_GROUND,
                        disableDepthTestDistance: ALWAYS_ON_TOP,
                    },
                });
            }
        });
        if (closed) {
            points.forEach((p, i) => {
                const id = `${MIDPOINT}${i}`;
                want.add(id);
                const at = toCartesian(midpoint(p, points[(i + 1) % points.length]!));
                const existing = ds.entities.getById(id);
                if (existing) existing.position = new ConstantPositionProperty(at);
                else
                    ds.entities.add({
                        id,
                        position: at,
                        point: {
                            pixelSize: 7,
                            color: C.white,
                            outlineColor: C.boundary,
                            outlineWidth: 2,
                            heightReference: HeightReference.CLAMP_TO_GROUND,
                            disableDepthTestDistance: ALWAYS_ON_TOP,
                        },
                    });
            });
        }
        for (const e of [...ds.entities.values]) {
            if ((e.id.startsWith(VERTEX) || e.id.startsWith(MIDPOINT)) && !want.has(e.id))
                ds.entities.remove(e);
        }
    }, [ds, points, closed]);

    const dragInsert = useRef<number | null>(null);

    useMapInput(active, {
        cursor: closed ? '' : 'crosshair',
        hoverable: (e) => e.id.startsWith(MIDPOINT),
        onMove: (point) => {
            cursor.current = point ? [point.lat, point.lon] : null;
        },
        onClick: (point, entity) => {
            const { points: pts, closed: done } = state.current;
            const v = entity ? indexOf(entity.id, VERTEX) : null;
            const m = entity ? indexOf(entity.id, MIDPOINT) : null;
            if (m !== null && done) {
                const next = pts.slice();
                next.splice(m + 1, 0, midpoint(pts[m]!, pts[(m + 1) % pts.length]!));
                change.current(next, true);
                return;
            }
            if (done || !point) return;
            if (v === 0 && pts.length >= 3) return change.current(pts, true);
            if (v !== null) return;
            addedAt.current = performance.now();
            change.current([...pts, [point.lat, point.lon]], false);
        },
        onDoubleClick: () => {
            const { points: pts, closed: done } = state.current;
            if (!done && pts.length >= 3) change.current(pts, true);
        },
        onRightClick: (_point, entity) => {
            const v = entity ? indexOf(entity.id, VERTEX) : null;
            const { points: pts, closed: done } = state.current;
            if (v === null || (done && pts.length <= 3)) return;
            change.current(
                pts.filter((_, i) => i !== v),
                done,
            );
        },
        draggable: (e) =>
            e.id.startsWith(VERTEX) || (state.current.closed && e.id.startsWith(MIDPOINT)),
        onDrag: (entity, point) => {
            const { points: pts, closed: done } = state.current;
            const next = pts.slice();
            let v = indexOf(entity.id, VERTEX);
            const m = indexOf(entity.id, MIDPOINT);
            if (m !== null) {
                // Dragging a midpoint turns it into a real point on the first move.
                if (dragInsert.current === null) {
                    next.splice(m + 1, 0, [point.lat, point.lon]);
                    dragInsert.current = m + 1;
                    change.current(next, done);
                    return;
                }
                v = dragInsert.current;
            }
            if (v === null || v >= next.length) return;
            next[v] = [point.lat, point.lon];
            change.current(next, done);
        },
        onDragEnd: () => {
            dragInsert.current = null;
        },
    });

    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
            const { points: pts, closed: done } = state.current;
            if ((e.key === 'Backspace' || e.key === 'Delete') && !done && pts.length) {
                change.current(pts.slice(0, -1), false);
            } else if (e.key === 'Enter' && !done && pts.length >= 3) {
                change.current(pts, true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [active]);

    return null;
}
