import {
    Cartesian2,
    ClassificationType,
    Color,
    HeightReference,
    LabelStyle,
    PolylineDashMaterialProperty,
} from 'cesium';
import { useEffect } from 'react';
import type { ZoneRoad } from '../../sim/types';
import { ALWAYS_ON_TOP, C, LABEL_FONT, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';

interface Props {
    roads: ZoneRoad[];
    /** Roads stand out while the operator is picking one. */
    picking: boolean;
}

/** The road network: open roads quiet, blocked ones red and dashed, uncertain ones amber. */
export function RoadsLayer({ roads, picking }: Props) {
    const ds = useDataSource('roads');

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        for (const road of roads) {
            if (road.path.length < 2) continue;
            const positions = road.path.map((p) => toCartesian(p));
            const open = road.state === 'open';
            const color = road.state === 'blocked' ? C.fire : C.risk;
            ds.entities.add({
                id: `road:${road.id}`,
                polyline: {
                    positions,
                    width: open ? (picking ? 6 : 2.5) : 5,
                    clampToGround: true,
                    classificationType: ClassificationType.BOTH,
                    material: open
                        ? C.ink.withAlpha(picking ? 0.7 : 0.3)
                        : new PolylineDashMaterialProperty({
                              color,
                              gapColor: Color.WHITE.withAlpha(0.85),
                              dashLength: 14,
                          }),
                },
            });
            if (open) continue;
            ds.entities.add({
                id: `road-label:${road.id}`,
                position: toCartesian(road.path[Math.floor(road.path.length / 2)]!),
                label: {
                    text: `${road.name ?? 'Road'} · ${road.state}`,
                    font: LABEL_FONT,
                    fillColor: color,
                    showBackground: true,
                    backgroundColor: Color.WHITE.withAlpha(0.92),
                    backgroundPadding: new Cartesian2(8, 5),
                    style: LabelStyle.FILL,
                    pixelOffset: new Cartesian2(0, -16),
                    heightReference: HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: ALWAYS_ON_TOP,
                },
            });
        }
    }, [ds, roads, picking]);

    return null;
}
