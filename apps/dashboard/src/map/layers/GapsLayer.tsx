import { useEffect, useState } from 'react';
import { computeCoverage } from '../../sim/geo';
import type { WatchZone } from '../../sim/types';
import { GridOverlay } from '../gridOverlay';
import { useMap } from '../viewer';

/** Hatches the ground no deployed edge server reaches, until the given time. */
export function GapsLayer({ zone, until }: { zone: WatchZone; until: number }) {
    const viewer = useMap((s) => s.viewer);
    const [active, setActive] = useState(false);

    useEffect(() => {
        const left = until - Date.now();
        setActive(left > 0);
        if (left <= 0) return;
        const timer = window.setTimeout(() => setActive(false), left);
        return () => window.clearTimeout(timer);
    }, [until]);

    useEffect(() => {
        if (!viewer || !active) return;
        const overlay = new GridOverlay(viewer, zone.grid);
        const { covered } = computeCoverage(
            zone.grid,
            zone.servers.filter((s) => s.status === 'deployed'),
        );
        const { cols } = zone.grid;
        overlay.paint((i) => {
            if (!zone.grid.inZone[i] || covered[i]) return null;
            const stripe = (Math.floor(i / cols) + (i % cols)) % 3 === 0;
            return stripe ? [196, 33, 112, 170] : [255, 79, 163, 90];
        });
        return () => overlay.destroy();
    }, [viewer, active, zone.grid, zone.servers]);

    return null;
}
