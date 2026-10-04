import { useEffect, useRef, useState } from 'react';
import { computeCoverage } from '../../model/geo';
import type { ZoneView } from '../../model/types';
import { deployed } from '../../model/zone';
import { GridOverlay } from '../gridOverlay';
import { useMap } from '../viewer';

/** Hatches the ground no deployed edge server reaches, until the given time. */
export function GapsLayer({ zone, until }: { zone: ZoneView; until: number }) {
    const viewer = useMap((s) => s.viewer);
    const [active, setActive] = useState(false);
    const latest = useRef(zone);
    latest.current = zone;
    const signature = deployed(zone)
        .map((s) => `${s.lat},${s.lon},${s.radiusM}`)
        .join('|');

    useEffect(() => {
        const left = until - Date.now();
        setActive(left > 0);
        if (left <= 0) return;
        const timer = window.setTimeout(() => setActive(false), left);
        return () => window.clearTimeout(timer);
    }, [until]);

    useEffect(() => {
        if (!viewer || !active) return;
        const { grid } = latest.current;
        const overlay = new GridOverlay(viewer, grid);
        const { covered } = computeCoverage(grid, deployed(latest.current));
        overlay.paint((i) => {
            if (!grid.inZone[i] || covered[i]) return null;
            const stripe = (Math.floor(i / grid.cols) + (i % grid.cols)) % 3 === 0;
            return stripe ? [196, 33, 112, 170] : [255, 79, 163, 90];
        });
        return () => overlay.destroy();
    }, [viewer, active, zone.grid, signature]);

    return null;
}
