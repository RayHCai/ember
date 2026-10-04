import { randomUUID } from 'node:crypto';
import type {
    EdgeServerLink,
    EdgeServerSite,
    EdgeServerTaskResult,
    LatLng,
    Scan,
    ScanState,
    StartMappingTask,
    StopMappingTask,
    WatchZoneId,
} from '@ember/contracts';
import type { Scan as ScanRow } from './generated/prisma/client.js';
import type { Db } from './db.js';
import { EdgeManagerError, type EdgeManager } from './edgeManager.js';

export const ACTIVE_SCAN_STATES: ScanState[] = ['starting', 'mapping', 'stopping'];
export const DEFAULT_CELL_SIZE_M = 10;
const ALTITUDE = { minM: 60, maxM: 120 };

/** A scan that cannot start or stop; `status` is the HTTP answer. */
export class ScanError extends Error {
    override name = 'ScanError';
    constructor(
        readonly status: 404 | 409 | 502 | 503,
        message: string,
    ) {
        super(message);
    }
}

export type ScanDeps = { db: Db; edgeManager: EdgeManager | null };

const resultsOf = (row: Pick<ScanRow, 'results'>) =>
    Array.isArray(row.results) ? (row.results as EdgeServerTaskResult[]) : [];

const refusals = (results: EdgeServerTaskResult[]) =>
    results.flatMap((r) => (r.ok ? [] : [`${r.edgeServerId}: ${r.error}`])).join('; ');

export function scanWire(row: ScanRow, coverage: number): Scan {
    return {
        runId: row.runId,
        zoneId: row.zoneId as WatchZoneId,
        requestedBy: row.requestedBy,
        state: row.state,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        cellSizeM: row.cellSizeM,
        results: resultsOf(row),
        coverage,
        error: row.error,
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** Each run's mean coverage over the mapping runs of its edge servers; 0 before any reports. */
export async function scanCoverage(db: Db, runIds: string[]): Promise<Map<string, number>> {
    if (runIds.length === 0) return new Map();
    const runs = await db.mappingRun.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, coverage: true },
    });
    const sums = new Map<string, { total: number; n: number }>();
    for (const run of runs) {
        const sum = sums.get(run.runId) ?? { total: 0, n: 0 };
        sum.total += run.coverage;
        sum.n += 1;
        sums.set(run.runId, sum);
    }
    return new Map(
        runIds.map((id) => {
            const sum = sums.get(id);
            return [id, sum ? sum.total / sum.n : 0];
        }),
    );
}

export async function scansWire(db: Db, rows: ScanRow[]): Promise<Scan[]> {
    const coverage = await scanCoverage(
        db,
        rows.map((r) => r.runId),
    );
    return rows.map((row) => scanWire(row, coverage.get(row.runId) ?? 0));
}

/**
 * Stores a `starting` scan and sends edge-manager a `StartMappingTask` for every edge server of the
 * zone with a position and radius. The scan is `mapping` once any edge server takes it, `failed`
 * when none does or edge-manager cannot be reached (then a 502 `ScanError`).
 */
export async function startScan(
    { db, edgeManager }: ScanDeps,
    zone: { id: string; boundary: unknown },
    { cellSizeM, requestedBy }: { cellSizeM: number; requestedBy: string },
): Promise<ScanRow> {
    if (!edgeManager) throw new ScanError(503, 'edge-manager is not configured');
    const active = await db.scan.findFirst({
        where: { zoneId: zone.id, state: { in: ACTIVE_SCAN_STATES } },
        select: { runId: true, state: true },
    });
    if (active) {
        throw new ScanError(409, `zone ${zone.id}: scan ${active.runId} is ${active.state}`);
    }
    const edges = await db.edgeServer.findMany({
        where: {
            zoneId: zone.id,
            lat: { not: null },
            lng: { not: null },
            connectivityRadiusM: { not: null },
        },
        orderBy: { id: 'asc' },
    });
    const sites: EdgeServerSite[] = edges.flatMap((e) =>
        e.lat === null || e.lng === null || e.connectivityRadiusM === null
            ? []
            : [
                  {
                      edgeServerId: e.id,
                      url: e.url,
                      location: { lat: e.lat, lng: e.lng },
                      connectivityRadiusM: e.connectivityRadiusM,
                  },
              ],
    );
    if (sites.length === 0) {
        throw new ScanError(409, `zone ${zone.id}: no edge server has a position and radius`);
    }

    const runId = `run-${randomUUID()}`;
    await db.scan.create({
        data: {
            runId,
            zoneId: zone.id,
            requestedBy,
            state: 'starting',
            startedAt: new Date(),
            cellSizeM,
            results: [],
        },
    });
    const task: StartMappingTask = {
        kind: 'start_mapping',
        runId,
        zoneId: zone.id as WatchZoneId,
        boundary: zone.boundary as LatLng[],
        cellSizeM,
        altitude: ALTITUDE,
        edgeServers: sites,
    };
    let results: EdgeServerTaskResult[];
    try {
        results = (await edgeManager.task(task)).results;
    } catch (err) {
        if (!(err instanceof EdgeManagerError)) throw err;
        await db.scan.update({
            where: { runId },
            data: { state: 'failed', endedAt: new Date(), error: err.message },
        });
        throw new ScanError(502, `scan ${runId}: ${err.message}`);
    }
    const taken = results.some((r) => r.ok);
    return db.scan.update({
        where: { runId },
        data: taken
            ? { state: 'mapping', results, error: refusals(results) || null }
            : {
                  state: 'failed',
                  results,
                  endedAt: new Date(),
                  error: refusals(results) || 'edge-manager answered with no edge servers',
              },
    });
}

/** Sends the stop to every edge server that took the scan and marks it `stopping`. */
export async function stopScan(
    { db, edgeManager }: ScanDeps,
    zoneId: string,
    runId: string,
): Promise<ScanRow> {
    const scan = await db.scan.findUnique({ where: { runId } });
    if (!scan || scan.zoneId !== zoneId) {
        throw new ScanError(404, `scan ${runId} of watch zone ${zoneId} not found`);
    }
    if (scan.state === 'stopping') return scan;
    if (scan.state === 'starting') throw new ScanError(409, `scan ${runId} is still starting`);
    if (scan.state !== 'mapping') throw new ScanError(409, `scan ${runId} is ${scan.state}`);
    if (!edgeManager) throw new ScanError(503, 'edge-manager is not configured');
    const took = resultsOf(scan).flatMap((r) => (r.ok ? [r.edgeServerId] : []));
    const edgeServers: EdgeServerLink[] = (
        await db.edgeServer.findMany({
            where: { id: { in: took } },
            select: { id: true, url: true },
            orderBy: { id: 'asc' },
        })
    ).map((e) => ({ edgeServerId: e.id, url: e.url }));
    if (edgeServers.length === 0) {
        return db.scan.update({ where: { runId }, data: { state: 'done', endedAt: new Date() } });
    }
    const task: StopMappingTask = {
        kind: 'stop_mapping',
        runId,
        zoneId: zoneId as WatchZoneId,
        edgeServers,
    };
    try {
        await edgeManager.task(task);
    } catch (err) {
        if (!(err instanceof EdgeManagerError)) throw err;
        throw new ScanError(502, `scan ${runId}: ${err.message}`);
    }
    return db.scan.update({ where: { runId }, data: { state: 'stopping' } });
}

/**
 * Follows a mapping-run report: a `starting` scan is `mapping`, and it is `done` once every edge
 * server that took it has reported and all of them are `done`.
 */
export async function syncScan(db: Db, runId: string, now = new Date()): Promise<void> {
    const scan = await db.scan.findUnique({ where: { runId } });
    if (!scan || !ACTIVE_SCAN_STATES.includes(scan.state)) return;
    const runs = await db.mappingRun.findMany({
        where: { runId },
        select: { edgeServerId: true, state: true },
    });
    const reported = new Set(runs.map((r) => r.edgeServerId));
    const took = resultsOf(scan).flatMap((r) => (r.ok ? [r.edgeServerId] : []));
    const done =
        took.length > 0 &&
        took.every((id) => reported.has(id)) &&
        runs.every((r) => r.state === 'done');
    const state = done ? 'done' : scan.state === 'starting' ? 'mapping' : scan.state;
    if (state === scan.state) return;
    await db.scan.update({
        where: { runId },
        data: done ? { state, endedAt: now } : { state },
    });
}
