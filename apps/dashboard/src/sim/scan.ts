import { notify } from '../store/notifications';
import { useZones } from '../store/zones';
import { dockDrone, dockPosition, dockSlot } from './fleet';
import { cellCenter, projector } from './geo';
import { getTelemetry, patchTelemetry } from './live';
import type { LatLon, WatchZone } from './types';
import { cellTruth } from './world';

// The dummy fleet: a scan launches every paired drone, flies each one a lawnmower
// pattern over the cells nearest its edge server, and maps cells as the camera passes.

const CRUISE_ALT_M = 120;
const TOUCH_MS = 150;

interface Flight {
    droneId: string;
    path: LatLon[];
    cum: number[];
    total: number;
    /** [distance along path, cell index], sorted by distance. */
    cells: [number, number][];
    cursor: number;
    startBattery: number;
}

interface Run {
    id: string;
    zoneId: string;
    kind: 'scan' | 'recall';
    startedAt: number;
    durationMs: number;
    flights: Flight[];
    found: { fire: boolean; risk: boolean };
    lastTouch: number;
}

const runs = new Map<string, Run>();
const fresh = new Map<string, Uint8Array>();
let frame = 0;
let heartbeat = 0;

/** Cells seen by the current or last scan of a zone. */
export function freshCells(zoneId: string): Uint8Array | undefined {
    return fresh.get(zoneId);
}

function cumulative(path: LatLon[]): number[] {
    const project = projector(path[0]!);
    const out = [0];
    for (let i = 1; i < path.length; i++) {
        const [x0, y0] = project(path[i - 1]!);
        const [x1, y1] = project(path[i]!);
        out.push(out[i - 1]! + Math.hypot(x1 - x0, y1 - y0));
    }
    return out;
}

function pointAt(
    f: Pick<Flight, 'path' | 'cum' | 'total'>,
    d: number,
): { at: LatLon; heading: number } {
    const dist = Math.max(0, Math.min(f.total, d));
    let i = 1;
    while (i < f.cum.length - 1 && f.cum[i]! < dist) i++;
    const a = f.path[i - 1]!;
    const b = f.path[i]!;
    const t = (dist - f.cum[i - 1]!) / (f.cum[i]! - f.cum[i - 1]! || 1);
    const [bx, by] = projector(a)(b);
    return {
        at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        heading: ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360,
    };
}

function planFlights(zone: WatchZone): Flight[] {
    const { grid } = zone;
    const servers = zone.servers.filter((s) => s.status === 'deployed');
    const project = projector([grid.south, grid.west]);
    const sxy = servers.map((s) => ({ id: s.id, xy: project([s.lat, s.lon]) }));
    const byServer = new Map<string, number[]>();
    for (let i = 0; i < grid.inZone.length; i++) {
        if (!grid.inZone[i]) continue;
        const [x, y] = project(cellCenter(grid, i));
        let best = sxy[0]!;
        for (const s of sxy) {
            if (
                (s.xy[0] - x) ** 2 + (s.xy[1] - y) ** 2 <
                (best.xy[0] - x) ** 2 + (best.xy[1] - y) ** 2
            )
                best = s;
        }
        byServer.set(best.id, [...(byServer.get(best.id) ?? []), i]);
    }

    const flights: Flight[] = [];
    for (const server of servers) {
        const drones = zone.drones.filter((d) => d.serverId === server.id);
        if (drones.length === 0) continue;
        const bands = new Map<number, number[]>();
        for (const cell of byServer.get(server.id) ?? []) {
            const band = Math.floor(cell / grid.cols / 2);
            bands.set(band, [...(bands.get(band) ?? []), cell]);
        }
        const order = [...bands.keys()].sort((a, b) => a - b);
        drones.forEach((drone, k) => {
            const dock = dockPosition(server, Math.max(0, dockSlot(zone, drone)));
            const path: LatLon[] = [dock];
            const cells: number[] = [];
            order
                .filter((_, i) => i % drones.length === k)
                .forEach((band, i) => {
                    const list = bands.get(band)!;
                    const cols = list.map((c) => c % grid.cols);
                    const lat = grid.south + (band * 2 + 1) * grid.dlat;
                    const west = grid.west + (Math.min(...cols) + 0.5) * grid.dlon;
                    const east = grid.west + (Math.max(...cols) + 0.5) * grid.dlon;
                    const [from, to] = i % 2 === 0 ? [west, east] : [east, west];
                    path.push([lat, from], [lat, to]);
                    cells.push(...list);
                });
            path.push(dock);
            const cum = cumulative(path);
            const located = cells.map((c): [number, number] => {
                const [px, py] = project(cellCenter(grid, c));
                let best = 0;
                let bestD = Infinity;
                for (let s = 1; s < path.length; s++) {
                    const [ax, ay] = project(path[s - 1]!);
                    const [bx, by] = project(path[s]!);
                    const dx = bx - ax;
                    const dy = by - ay;
                    const len2 = dx * dx + dy * dy || 1;
                    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
                    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
                    if (d < bestD) {
                        bestD = d;
                        best = cum[s - 1]! + t * Math.sqrt(len2);
                    }
                }
                return [best, c];
            });
            flights.push({
                droneId: drone.id,
                path,
                cum,
                total: cum[cum.length - 1]!,
                cells: located.sort((a, b) => a[0] - b[0]),
                cursor: 0,
                startBattery: getTelemetry(drone.id)?.batteryPct ?? 100,
            });
        });
    }
    return flights;
}

export function startScan(zoneId: string): string | null {
    const zone = useZones.getState().zones[zoneId];
    if (!zone) return 'That watch zone no longer exists.';
    if (runs.has(zoneId)) return 'A scan is already running.';
    if (!zone.servers.some((s) => s.status === 'deployed'))
        return 'Deploy edge servers before scanning.';
    if (zone.drones.length === 0) return 'Pair at least one drone before scanning.';
    const flights = planFlights(zone);
    if (flights.length === 0) return 'No drones are docked at a deployed edge server.';

    const now = performance.now();
    const durationMs = 26_000 + Math.min(16_000, zone.grid.inZoneCount * 5);
    runs.set(zoneId, {
        id: `scan-${Date.now().toString(36)}`,
        zoneId,
        kind: 'scan',
        startedAt: now,
        durationMs,
        flights,
        found: { fire: false, risk: false },
        lastTouch: 0,
    });
    fresh.set(zoneId, new Uint8Array(zone.grid.rows * zone.grid.cols));
    useZones.getState().update(zoneId, {
        scan: { id: zoneId, startedAt: Date.now(), endsAt: Date.now() + durationMs, progress: 0 },
    });
    notify('info', 'Scan started', `${flights.length} drones launched over ${zone.name}.`, zone);
    loop();
    return null;
}

/** Recall every drone of a zone straight home. */
export function stopScan(zoneId: string): void {
    const run = runs.get(zoneId);
    const zone = useZones.getState().zones[zoneId];
    if (!run || !zone || run.kind === 'recall') return;
    const flights: Flight[] = run.flights.map((f) => {
        const t = getTelemetry(f.droneId);
        const here: LatLon = t ? [t.lat, t.lon] : f.path[0]!;
        const path = [here, f.path[f.path.length - 1]!];
        const cum = cumulative(path);
        return {
            ...f,
            path,
            cum,
            total: cum[1]!,
            cells: [],
            cursor: 0,
            startBattery: t?.batteryPct ?? f.startBattery,
        };
    });
    runs.set(zoneId, {
        ...run,
        kind: 'recall',
        startedAt: performance.now(),
        durationMs: 3500,
        flights,
    });
    notify(
        'warning',
        'Scan stopped',
        `Drones over ${zone.name} are returning to their edge servers.`,
        zone,
    );
}

export function isScanning(zoneId: string): boolean {
    return runs.has(zoneId);
}

function finish(run: Run, zone: WatchZone): void {
    runs.delete(run.zoneId);
    for (const f of run.flights) {
        const drone = zone.drones.find((d) => d.id === f.droneId);
        if (drone) dockDrone(zone, drone, getTelemetry(f.droneId)?.batteryPct);
    }
    const store = useZones.getState();
    store.update(run.zoneId, (z) => ({
        scan: null,
        lastScanAt: run.kind === 'scan' ? Date.now() : z.lastScanAt,
        schedule: z.schedule.enabled
            ? { ...z.schedule, nextAt: Date.now() + z.schedule.everyHours * 3_600_000 }
            : z.schedule,
        riskVersion: z.riskVersion + 1,
    }));
    if (run.kind !== 'scan') return;
    const mapped = fresh.get(run.zoneId)?.reduce((s, v) => s + v, 0) ?? 0;
    const pct = Math.round((100 * mapped) / Math.max(1, zone.grid.inZoneCount));
    const finding = run.found.fire
        ? 'Active fire present.'
        : run.found.risk
          ? 'At-risk vegetation found.'
          : 'No risk found.';
    notify(
        run.found.fire ? 'critical' : run.found.risk ? 'warning' : 'success',
        'Scan complete',
        `${zone.name}: ${pct}% mapped. ${finding}`,
        zone,
    );
}

function step(run: Run, now: number): void {
    const zone = useZones.getState().zones[run.zoneId];
    if (!zone) {
        runs.delete(run.zoneId);
        return;
    }
    const t = Math.min(1, (now - run.startedAt) / run.durationMs);
    const seen = fresh.get(run.zoneId);
    for (const f of run.flights) {
        const d = t * f.total;
        const { at, heading } = pointAt(f, d);
        const edge = run.kind === 'recall' ? 1 : Math.min(t / 0.04, (1 - t) / 0.04, 1);
        patchTelemetry(f.droneId, {
            lat: at[0],
            lon: at[1],
            headingDeg: heading,
            altM: CRUISE_ALT_M * Math.max(0, Math.min(1, edge)),
            speedMs: t < 1 ? Math.round((f.total / (run.durationMs / 1000)) * 0.045 * 10) / 10 : 0,
            batteryPct: Math.max(
                18,
                Math.round(f.startBattery - (run.kind === 'scan' ? 46 : 4) * t),
            ),
            state:
                t >= 1
                    ? 'charging'
                    : run.kind === 'recall' || t > 0.94
                      ? 'returning'
                      : t < 0.04
                        ? 'launching'
                        : 'scanning',
            lastSeenAt: Date.now(),
        });
        while (f.cursor < f.cells.length && f.cells[f.cursor]![0] <= d) {
            const cell = f.cells[f.cursor]![1];
            const truth = cellTruth(zone, cell);
            zone.risk[cell] = truth;
            if (seen) seen[cell] = 1;
            f.cursor += 1;
            const drone = zone.drones.find((x) => x.id === f.droneId);
            if (truth === 3 && !run.found.fire) {
                run.found.fire = true;
                const [lat, lon] = cellCenter(zone.grid, cell);
                notify(
                    'critical',
                    'Fire detected',
                    `${drone?.name ?? 'A drone'} confirmed active fire at ${lat.toFixed(4)}, ${lon.toFixed(4)}.`,
                    zone,
                    zone.responders.length,
                );
            } else if (truth === 2 && !run.found.risk) {
                run.found.risk = true;
                notify(
                    'warning',
                    'At-risk area found',
                    `${drone?.name ?? 'A drone'} flagged dry fuel in ${zone.name}.`,
                    zone,
                    zone.responders.length,
                );
            }
        }
    }
    if (now - run.lastTouch > TOUCH_MS || t >= 1) {
        run.lastTouch = now;
        if (run.kind === 'scan') {
            useZones.getState().update(run.zoneId, (z) => ({
                riskVersion: z.riskVersion + 1,
                scan: z.scan ? { ...z.scan, progress: t } : z.scan,
            }));
        }
    }
    if (t >= 1) finish(run, zone);
}

function loop(): void {
    if (frame) return;
    const tick = () => {
        frame = 0;
        const now = performance.now();
        for (const run of [...runs.values()]) step(run, now);
        if (runs.size > 0) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
}

/** Charging and the repeat schedule tick once a second. */
export function startFleetHeartbeat(): () => void {
    if (heartbeat) return () => {};
    heartbeat = window.setInterval(() => {
        const { zones } = useZones.getState();
        const now = Date.now();
        for (const zone of Object.values(zones)) {
            if (
                zone.schedule.enabled &&
                zone.schedule.nextAt &&
                zone.schedule.nextAt <= now &&
                !runs.has(zone.id)
            ) {
                startScan(zone.id);
            }
            if (runs.has(zone.id)) continue;
            for (const drone of zone.drones) {
                const t = getTelemetry(drone.id);
                if (!t) continue;
                if (t.state === 'charging') {
                    const batteryPct = Math.min(100, t.batteryPct + 1);
                    patchTelemetry(drone.id, {
                        batteryPct,
                        state: batteryPct >= 100 ? 'docked' : 'charging',
                        lastSeenAt: now,
                    });
                } else {
                    patchTelemetry(drone.id, { lastSeenAt: now });
                }
            }
        }
    }, 1000);
    return () => {
        window.clearInterval(heartbeat);
        heartbeat = 0;
    };
}
