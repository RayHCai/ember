import { CallbackProperty, HeightReference } from 'cesium';
import { useEffect, useRef } from 'react';
import { cellCenter, centroid } from '../../sim/geo';
import { freshCells } from '../../sim/scan';
import type { LatLon, WatchZone } from '../../sim/types';
import { prefersReducedMotion } from '../camera';
import { GridOverlay, type CellColor } from '../gridOverlay';
import { ALWAYS_ON_TOP, ICONS, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';
import { useMap } from '../viewer';
import { frameMilliseconds } from '../frameClock';

const MAPPED: CellColor = [46, 158, 91, 100];
const MAPPED_STALE: CellColor = [46, 158, 91, 30];
const AT_RISK: CellColor = [242, 169, 0, 178];
const ON_FIRE: CellColor = [229, 50, 27, 220];

/** Groups burning cells into fires (4-connected), returning each fire's centre. */
export function fireCentres(zone: WatchZone): LatLon[] {
    const { grid, risk } = zone;
    const seen = new Uint8Array(risk.length);
    const out: LatLon[] = [];
    for (let i = 0; i < risk.length; i++) {
        if (risk[i] !== 3 || seen[i]) continue;
        const stack = [i];
        const cells: LatLon[] = [];
        seen[i] = 1;
        while (stack.length) {
            const c = stack.pop()!;
            cells.push(cellCenter(grid, c));
            const row = Math.floor(c / grid.cols);
            const col = c % grid.cols;
            for (const [r, k] of [
                [row + 1, col],
                [row - 1, col],
                [row, col + 1],
                [row, col - 1],
            ] as const) {
                if (r < 0 || r >= grid.rows || k < 0 || k >= grid.cols) continue;
                const n = r * grid.cols + k;
                if (risk[n] === 3 && !seen[n]) {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
        }
        if (cells.length >= 3) out.push(centroid(cells));
    }
    return out;
}

/**
 * What the drones have seen: mapped ground fills in with color over the black and white
 * base, yellow where vegetation is at risk, red where it burns.
 */
export function DetectionLayer({ zone, visible }: { zone: WatchZone; visible: boolean }) {
    const viewer = useMap((s) => s.viewer);
    const ds = useDataSource('detection');
    const overlay = useRef<GridOverlay | null>(null);
    const frame = useRef(0);
    const { grid } = zone;

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
            const fresh = freshCells(zone.id);
            const scanning = zone.scan !== null;
            o.paint((i) => {
                const r = zone.risk[i];
                if (r === 3) return ON_FIRE;
                if (r === 2) return AT_RISK;
                if (r === 1) return scanning && !fresh?.[i] ? MAPPED_STALE : MAPPED;
                return null;
            });
        });
    }, [zone, zone.riskVersion, visible, viewer]);

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        if (!visible) return;
        const reduced = prefersReducedMotion();
        fireCentres(zone).forEach((at, i) => {
            ds.entities.add({
                id: `fire:${i}`,
                position: toCartesian(at),
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
        });
    }, [ds, zone, zone.riskVersion, visible]);

    return null;
}
