import type { LatLng } from '@ember/contracts';
import { useMemo } from 'react';
import { metersPerDegLon } from '../model/geo';
import type { ZoneStatus } from '../model/types';

const FILL: Record<ZoneStatus, string> = {
    setup: 'rgba(47,107,255,0.06)',
    awaiting: 'rgba(47,107,255,0.08)',
    healthy: 'rgba(46,158,91,0.22)',
    at_risk: 'rgba(242,169,0,0.30)',
    on_fire: 'rgba(229,50,31,0.30)',
};

/** Fits lat/lng into a box, keeping the zone's true proportions. */
function fitter(points: LatLng[], w: number, h: number, pad: number) {
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lng);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const kx = metersPerDegLon((south + north) / 2) / 111_320;
    const spanX = (east - west) * kx || 1e-9;
    const spanY = north - south || 1e-9;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanY * scale) / 2;
    return (p: LatLng): [number, number] => [
        ox + (p.lng - west) * kx * scale,
        oy + (north - p.lat) * scale,
    ];
}

interface Props {
    boundary: LatLng[];
    status: ZoneStatus;
    width?: number;
    height?: number;
}

/** The zone's outline, tinted by its status. */
export function ZoneShape({ boundary, status, width = 320, height = 150 }: Props) {
    const outline = useMemo(() => {
        const project = fitter(boundary, width, height, 18);
        return boundary.map((p) => project(p).join(',')).join(' ');
    }, [boundary, width, height]);

    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden
        >
            <polygon
                points={outline}
                fill={FILL[status]}
                stroke="#2F6BFF"
                strokeWidth={1.5}
                strokeLinejoin="round"
            />
        </svg>
    );
}
