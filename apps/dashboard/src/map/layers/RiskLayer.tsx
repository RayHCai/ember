import {
    Cartesian2,
    ClassificationType,
    Color,
    HeightReference,
    HorizontalOrigin,
    LabelStyle,
    NearFarScalar,
    PolylineDashMaterialProperty,
    VerticalOrigin,
} from 'cesium';
import type { RiskZone } from '@ember/contracts';
import { useEffect, useRef } from 'react';
import { liveDetections, useDroneInfo } from '../../live/droneInfo';
import { distinct, spaced } from '../../model/geo';
import { hectares } from '../../model/zone';
import { ALWAYS_ON_TOP, C, LABEL_FONT, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';

const LIVE_REDRAW_MS = 400;

function boxCorners(z: RiskZone) {
    const { south, west, north, east } = z.bbox;
    return [
        [north, west],
        [north, east],
        [south, east],
        [south, west],
        [north, west],
    ].map(([lat, lon]) => toCartesian([lat!, lon!]));
}

interface Props {
    zones: RiskZone[];
    /** Draw the boxes of frames drone-info is streaming (during a scan). */
    live: boolean;
    visible: boolean;
    selectedId?: string | null;
}

/**
 * A bounding box around each risk zone the api merged from the drones' detections, labelled with
 * its class, confidence and area; while a scan runs, the boxes of the newest frames as they land.
 */
export function RiskLayer({ zones, live, visible, selectedId = null }: Props) {
    const boxes = useDataSource('risk-boxes');
    const frames = useDataSource('risk-live');
    const version = useDroneInfo((s) => s.detectionsVersion);
    const drawnAt = useRef(0);
    const pending = useRef(0);

    useEffect(() => {
        if (!boxes) return;
        boxes.entities.removeAll();
        if (!visible) return;
        // The api lists fires first and larger areas first, so crowded small ones lose their labels.
        const labelled = spaced(
            zones.map((z) => [z.bbox.north, z.bbox.west]),
            120,
        );
        zones.forEach((z, n) => {
            const fire = z.risk === 'on_fire';
            const color = fire ? C.fire : C.risk;
            const selected = z.id === selectedId;
            const corners = boxCorners(z);
            boxes.entities.add({
                id: `risk:${z.id}`,
                polyline: {
                    positions: corners,
                    width: selected ? 4 : 2.5,
                    clampToGround: true,
                    classificationType: ClassificationType.BOTH,
                    material: color,
                },
            });
            if (!labelled[n] && !selected) return;
            boxes.entities.add({
                id: `risk-label:${z.id}`,
                position: corners[0],
                label: {
                    text: `${fire ? 'On fire' : 'At risk'} ${Math.round(z.confidence * 100)}% · ${hectares(z.areaM2 / 10_000)} ha`,
                    font: LABEL_FONT,
                    fillColor: Color.WHITE,
                    showBackground: true,
                    backgroundColor: color.withAlpha(0.92),
                    backgroundPadding: new Cartesian2(6, 3),
                    style: LabelStyle.FILL,
                    verticalOrigin: VerticalOrigin.BOTTOM,
                    horizontalOrigin: HorizontalOrigin.LEFT,
                    pixelOffset: new Cartesian2(0, -4),
                    heightReference: HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: ALWAYS_ON_TOP,
                    scaleByDistance: new NearFarScalar(2_000, 1, 40_000, 0.6),
                },
            });
        });
    }, [boxes, zones, visible, selectedId]);

    useEffect(() => {
        if (!frames) return;
        const draw = () => {
            drawnAt.current = performance.now();
            frames.entities.removeAll();
            if (!visible || !live) return;
            for (const f of liveDetections()) {
                f.detections.forEach((d, i) => {
                    const path = distinct(d.ground.map((p) => [p.lat, p.lng]));
                    if (path.length < 3) return;
                    const ring = [...path, path[0]!].map((p) => toCartesian(p));
                    frames.entities.add({
                        id: `frame:${f.droneId}:${f.frameId}:${i}`,
                        polyline: {
                            positions: ring,
                            width: 1.5,
                            clampToGround: true,
                            classificationType: ClassificationType.BOTH,
                            material: new PolylineDashMaterialProperty({
                                color: (d.risk === 'on_fire' ? C.fire : C.risk).withAlpha(0.8),
                                dashLength: 8,
                            }),
                        },
                    });
                });
            }
        };
        const wait = LIVE_REDRAW_MS - (performance.now() - drawnAt.current);
        window.clearTimeout(pending.current);
        if (wait <= 0) draw();
        else pending.current = window.setTimeout(draw, wait);
        return () => window.clearTimeout(pending.current);
    }, [frames, version, visible, live]);

    return null;
}
