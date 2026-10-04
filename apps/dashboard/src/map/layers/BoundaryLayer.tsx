import {
    CallbackProperty,
    ClassificationType,
    ColorMaterialProperty,
    PolygonHierarchy,
} from 'cesium';
import { useEffect, useRef } from 'react';
import type { LatLon } from '../../sim/types';
import { C, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';

interface Props {
    boundary: LatLon[];
    /** How strongly the land outside the boundary is washed out, 0 to 1. */
    outside: number;
    /** Tint inside the boundary, 0 to 1. */
    fill?: number;
}

const MARGIN_DEG = 0.6;

/**
 * The watch zone's boundary in blue, with everything outside it washed toward white
 * so the forest itself keeps its color.
 */
export function BoundaryLayer({ boundary, outside, fill = 0.05 }: Props) {
    const ds = useDataSource('boundary');
    const level = useRef({ outside, fill, shownOutside: 0, shownFill: 0 });
    level.current.outside = outside;
    level.current.fill = fill;

    useEffect(() => {
        if (!ds || boundary.length < 3) return;
        const positions = boundary.map((p) => toCartesian(p));
        const lats = boundary.map((p) => p[0]);
        const lons = boundary.map((p) => p[1]);
        const s = Math.min(...lats) - MARGIN_DEG;
        const n = Math.max(...lats) + MARGIN_DEG;
        const w = Math.min(...lons) - MARGIN_DEG;
        const e = Math.max(...lons) + MARGIN_DEG;
        const outer: LatLon[] = [
            [s, w],
            [s, e],
            [n, e],
            [n, w],
        ];
        // Levels ease toward their targets each frame, so mode switches fade.
        const ease = (key: 'shownOutside' | 'shownFill', target: number) => {
            const l = level.current;
            l[key] += (target - l[key]) * 0.12;
            return l[key];
        };
        ds.entities.add({
            id: 'boundary-mask',
            polygon: {
                hierarchy: new PolygonHierarchy(
                    outer.map((p) => toCartesian(p)),
                    [new PolygonHierarchy(positions)],
                ),
                material: new ColorMaterialProperty(
                    new CallbackProperty(
                        () => C.white.withAlpha(ease('shownOutside', level.current.outside)),
                        false,
                    ),
                ),
                classificationType: ClassificationType.BOTH,
            },
        });
        ds.entities.add({
            id: 'boundary-fill',
            polygon: {
                hierarchy: new PolygonHierarchy(positions),
                material: new ColorMaterialProperty(
                    new CallbackProperty(
                        () => C.boundary.withAlpha(ease('shownFill', level.current.fill)),
                        false,
                    ),
                ),
                classificationType: ClassificationType.BOTH,
            },
        });
        ds.entities.add({
            id: 'boundary-glow',
            polyline: {
                positions: [...positions, positions[0]!],
                width: 9,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: C.boundary.withAlpha(0.16),
            },
        });
        ds.entities.add({
            id: 'boundary-edge',
            polyline: {
                positions: [...positions, positions[0]!],
                width: 2.5,
                clampToGround: true,
                classificationType: ClassificationType.BOTH,
                material: C.boundary,
            },
        });
        return () => ds.entities.removeAll();
    }, [ds, boundary]);

    return null;
}
