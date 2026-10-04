/** Low-precision solar position (Demo Data's `render/sun.py`, plus azimuth), ~0.1 degree. */
export function sunPosition(
    lat: number,
    lng: number,
    timeMs: number,
): { elevationDeg: number; azimuthDeg: number } {
    const rad = Math.PI / 180;
    const n = timeMs / 86_400_000 + 2_440_587.5 - 2_451_545.0;
    const meanLon = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
    const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * rad;
    const eclLon = meanLon * rad + 1.915 * rad * Math.sin(g) + 0.02 * rad * Math.sin(2 * g);
    const eps = (23.439 - 0.0000004 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(eclLon), Math.cos(eclLon));
    const dec = Math.asin(Math.sin(eps) * Math.sin(eclLon));
    const gmstH = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
    const ha = (gmstH * 15 + lng) * rad - ra;
    const la = lat * rad;
    const elevation = Math.asin(
        Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha),
    );
    const azimuth = Math.atan2(
        -Math.sin(ha),
        Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha),
    );
    return { elevationDeg: elevation / rad, azimuthDeg: (((azimuth / rad) % 360) + 360) % 360 };
}

/** Relative scene illumination: 1 in full sun, ~0.02 on a moonless night. */
export function daylight(elevationDeg: number): number {
    const pts: [number, number][] = [
        [-18, 0.02],
        [-12, 0.025],
        [-6, 0.12],
        [0, 0.5],
        [10, 0.95],
        [25, 1.0],
    ];
    if (elevationDeg <= pts[0]![0]) return pts[0]![1];
    for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1]!;
        const [x1, y1] = pts[i]!;
        if (elevationDeg <= x1) return y0 + ((y1 - y0) * (elevationDeg - x0)) / (x1 - x0);
    }
    return 1;
}
