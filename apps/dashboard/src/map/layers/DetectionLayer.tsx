import { CallbackProperty, HeightReference } from 'cesium';
import { useEffect, useMemo, useRef } from 'react';
import { liveDetections, useDroneInfo } from '../../live/droneInfo';
import { MAPPED_NOW, ON_FIRE, mappedCells, riskCells } from '../../model/raster';
import type { ZoneView } from '../../model/types';
import { ll } from '../../model/zone';
import { prefersReducedMotion } from '../camera';
import { GridOverlay, type CellColor } from '../gridOverlay';
import { ALWAYS_ON_TOP, ICONS, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';
import { useMap } from '../viewer';
import { frameMilliseconds } from '../frameClock';

const MAPPED: CellColor = [46, 158, 91, 100];
const MAPPED_STALE: CellColor = [46, 158, 91, 30];
const AT_RISK: CellColor = [242, 169, 0, 178];
const FIRE: CellColor = [229, 50, 27, 220];

/**
 * What the drones have seen: ground mapped by any run fills in green over the black and white
 * base (the running scan's cells brighter), yellow where vegetation is at risk, red where it
 * burns. Risk comes from the api's risk zones plus the frames drone-info just streamed.
 */
export function DetectionLayer({ zone, visible }: { zone: ZoneView; visible: boolean }) {
    const viewer = useMap((s) => s.viewer);
    const ds = useDataSource('detection');
    const overlay = useRef<GridOverlay | null>(null);
    const frame = useRef(0);
    const detectionsVersion = useDroneInfo((s) => s.detectionsVersion);
    const { grid } = zone;
    const currentRun = zone.scan?.runId ?? null;

    const mapped = useMemo(
        () => mappedCells(grid, zone.runs, currentRun),
        [grid, zone.runs, currentRun],
    );

    useEffect(() => {
        if (!viewer) return;
        overlay.current = new GridOverlay(viewer, grid);
        return () => {
            overlay.current?.destroy();
            overlay.current = null;
        };
    }, [viewer, grid]);

    useEffect(() => {
        const o = overlay.current;
        if (!o) return;
        o.show = visible;
        if (!visible) return;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
            const risk = riskCells(grid, zone.riskZones, currentRun ? liveDetections() : []);
            const scanning = currentRun !== null;
            o.paint((i) => {
                const r = risk[i];
                if (r === ON_FIRE) return FIRE;
                if (r) return AT_RISK;
                const m = mapped[i];
                if (!m) return null;
                return scanning && m !== MAPPED_NOW ? MAPPED_STALE : MAPPED;
            });
        });
        return () => cancelAnimationFrame(frame.current);
    }, [grid, mapped, zone.riskZones, currentRun, detectionsVersion, visible, viewer]);

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        if (!visible) return;
        const reduced = prefersReducedMotion();
        for (const z of zone.riskZones) {
            if (z.risk !== 'on_fire') continue;
            ds.entities.add({
                id: `fire:${z.id}`,
                position: toCartesian(ll(z.center)),
                billboard: {
                    image: ICONS.fire,
                    width: 34,
                    height: 34,
                    scale: reduced
                        ? 1
                        : new CallbackProperty(
                              () => 1 + 0.12 * Math.sin(frameMilliseconds() / 180),
                              false,
                          ),
                    heightReference: HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: ALWAYS_ON_TOP,
                },
            });
        }
    }, [ds, zone.riskZones, visible]);

    return null;
}
