import { useId, useMemo } from 'react';
import { metersPerDegLon } from '../sim/geo';
import type { LatLon, WatchZone } from '../sim/types';

const CELL_RGBA: Record<number, [number, number, number, number]> = {
    0: [233, 226, 218, 255],
    1: [173, 214, 180, 255],
    2: [248, 196, 64, 255],
    3: [229, 50, 27, 255],
};

/** Fits lat/lon into a box, keeping the zone's true proportions. */
function fitter(points: LatLon[], w: number, h: number, pad: number) {
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const kx = metersPerDegLon((south + north) / 2) / 111_320;
    const spanX = (east - west) * kx;
    const spanY = north - south;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanY * scale) / 2;
    return ([lat, lon]: LatLon): [number, number] => [
        ox + (lon - west) * kx * scale,
        oy + (north - lat) * scale,
    ];
}

function riskImage(zone: WatchZone): string {
    const { rows, cols } = zone.grid;
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(cols, rows);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            if (!zone.grid.inZone[i]) continue;
            const rgba = CELL_RGBA[zone.risk[i] ?? 0]!;
            const o = ((rows - 1 - row) * cols + col) * 4;
            img.data.set(rgba, o);
        }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
}

interface Props {
    zone: WatchZone;
    width?: number;
    height?: number;
}

/** The zone's outline with a miniature of its detection map and edge server radii. */
export function ZoneShape({ zone, width = 320, height = 150 }: Props) {
    const clipId = useId();
    const project = useMemo(
        () => fitter(zone.boundary, width, height, 18),
        [zone.boundary, width, height],
    );
    // Every risk change replaces the zone object, so the zone alone keys the image.
    const image = useMemo(() => riskImage(zone), [zone]);
    const outline = zone.boundary.map((p) => project(p).join(',')).join(' ');
    const [x0, y0] = project([zone.grid.north, zone.grid.west]);
    const [x1, y1] = project([zone.grid.south, zone.grid.east]);
    const pxPerM =
        Math.abs(
            project([zone.grid.south, zone.grid.west])[1] -
                project([zone.grid.north, zone.grid.west])[1],
        ) /
        ((zone.grid.north - zone.grid.south) * 111_320);

    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden
        >
            <defs>
                <clipPath id={clipId}>
                    <polygon points={outline} />
                </clipPath>
            </defs>
            <image
                href={image}
                x={x0}
                y={y0}
                width={x1 - x0}
                height={y1 - y0}
                preserveAspectRatio="none"
                clipPath={`url(#${clipId})`}
                style={{ imageRendering: 'pixelated' }}
            />
            {zone.servers.map((s) => {
                const [cx, cy] = project([s.lat, s.lon]);
                return (
                    <g key={s.id}>
                        <circle
                            cx={cx}
                            cy={cy}
                            r={s.radiusM * pxPerM}
                            fill={
                                s.status === 'pending'
                                    ? 'rgba(255,79,163,0.10)'
                                    : 'rgba(255,79,163,0.07)'
                            }
                            stroke="#FF4FA3"
                            strokeOpacity={0.55}
                            strokeWidth={1}
                            strokeDasharray={s.status === 'pending' ? '3 3' : undefined}
                        />
                        <rect x={cx - 3} y={cy - 3} width={6} height={6} rx={1.5} fill="#1C1714" />
                    </g>
                );
            })}
            <polygon
                points={outline}
                fill="none"
                stroke="#2F6BFF"
                strokeWidth={2}
                strokeLinejoin="round"
            />
        </svg>
    );
}
