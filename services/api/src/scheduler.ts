import type { FastifyBaseLogger } from 'fastify';
import {
    ACTIVE_SCAN_STATES,
    DEFAULT_CELL_SIZE_M,
    ScanError,
    startScan,
    type ScanDeps,
} from './scans.js';

const HOUR_MS = 3_600_000;
const IDLE_MS = 10 * 60_000;
export const IDLE_ERROR = 'no updates from the edge for 10 minutes';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/**
 * Starts a scan for every zone whose repeat scan is due. The zone's next scan is moved on first,
 * conditionally, so a second api instance (or a failing start) never starts it twice.
 */
export async function startDueScans(deps: ScanDeps, log: Log, now = new Date()): Promise<string[]> {
    const zones = await deps.db.watchZone.findMany({
        where: { scanEveryHours: { not: null }, nextScanAt: { lte: now } },
        select: { id: true, boundary: true, scanEveryHours: true, nextScanAt: true },
    });
    const started = await Promise.all(
        zones.map(async (zone): Promise<string | null> => {
            if (zone.scanEveryHours === null) return null;
            const claimed = await deps.db.watchZone.updateMany({
                where: { id: zone.id, nextScanAt: zone.nextScanAt },
                data: { nextScanAt: new Date(now.getTime() + zone.scanEveryHours * HOUR_MS) },
            });
            if (claimed.count === 0) return null;
            try {
                const scan = await startScan(deps, zone, {
                    cellSizeM: DEFAULT_CELL_SIZE_M,
                    requestedBy: 'schedule',
                });
                if (scan.state !== 'failed') return scan.runId;
                log.warn(`zone ${zone.id}: repeat scan ${scan.runId} failed: ${scan.error}`);
            } catch (err) {
                if (err instanceof ScanError && err.status === 409) {
                    log.info(`zone ${zone.id}: repeat scan skipped: ${err.message}`);
                } else {
                    log.warn({ err }, `zone ${zone.id}: repeat scan did not start`);
                }
            }
            return null;
        }),
    );
    return started.filter((runId) => runId !== null);
}

/** Ends active scans that neither they nor their mapping runs have heard of for 10 minutes. */
export async function sweepIdleScans(deps: Pick<ScanDeps, 'db'>, now = new Date()) {
    const { db } = deps;
    const scans = await db.scan.findMany({
        where: { state: { in: ACTIVE_SCAN_STATES } },
        select: { runId: true, updatedAt: true },
    });
    if (scans.length === 0) return [];
    const runs = await db.mappingRun.findMany({
        where: { runId: { in: scans.map((s) => s.runId) } },
        select: { runId: true, updatedAt: true },
    });
    const lastRun = new Map<string, number>();
    for (const run of runs) {
        lastRun.set(run.runId, Math.max(lastRun.get(run.runId) ?? 0, run.updatedAt.getTime()));
    }
    const lastHeard = (scan: (typeof scans)[number]) =>
        Math.max(scan.updatedAt.getTime(), lastRun.get(scan.runId) ?? 0);
    const ended = await Promise.all(
        scans
            .filter((scan) => now.getTime() - lastHeard(scan) >= IDLE_MS)
            .map(async (scan) => {
                const { count } = await db.scan.updateMany({
                    where: { runId: scan.runId, state: { in: ACTIVE_SCAN_STATES } },
                    data: { state: 'done', endedAt: now, error: IDLE_ERROR },
                });
                return count > 0 ? scan.runId : null;
            }),
    );
    return ended.filter((runId) => runId !== null);
}

/** Runs both every `everyMs` until stopped; a tick never overlaps the previous one. */
export function startScheduler(deps: ScanDeps, log: Log, everyMs = 30_000) {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await startDueScans(deps, log);
            await sweepIdleScans(deps);
        } catch (err) {
            log.error({ err }, 'scan scheduler failed');
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => void tick(), everyMs);
    timer.unref();
    return { tick, stop: () => clearInterval(timer) };
}
