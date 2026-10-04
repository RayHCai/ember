import type { FastifyBaseLogger } from 'fastify';
import type {
    CivilianArea,
    LatLng,
    ResponderStation,
    Road,
    SafeZone,
    WatchZoneId,
    ZoneSurroundings,
} from '@ember/contracts';
import type { Prisma, ZoneSurroundings as SurroundingsRow } from './generated/prisma/client.js';
import type { Db } from './db.js';
import { orMissing } from './http.js';
import type { OpenData } from './openData/types.js';

export function surroundingsWire(row: SurroundingsRow, withRoads = true): ZoneSurroundings {
    return {
        zoneId: row.zoneId as WatchZoneId,
        status: row.status,
        source: row.source,
        fetchedAt: row.fetchedAt?.toISOString() ?? null,
        error: row.error,
        civilianAreas: row.civilianAreas as CivilianArea[],
        roads: withRoads ? (row.roads as Road[]) : [],
        safeZones: row.safeZones as SafeZone[],
        stations: row.stations as ResponderStation[],
    };
}

export type Surroundings = {
    /** Marks the zone's surroundings `pending` and fetches them in the background. */
    refresh(zoneId: string, boundary: LatLng[]): Promise<SurroundingsRow>;
    /** `refresh` without waiting; failures are logged, never thrown. */
    refreshLater(zoneId: string, boundary: LatLng[]): void;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createSurroundings({
    db,
    openData,
    log,
}: {
    db: Db;
    openData: OpenData | null;
    log: Pick<FastifyBaseLogger, 'error'>;
}): Surroundings {
    // The newest refresh per zone; an older fetch that finishes later does not overwrite it.
    const latest = new Map<string, number>();
    let refreshes = 0;

    async function fetchAndStore(zoneId: string, boundary: LatLng[], refresh: number) {
        let data: Prisma.ZoneSurroundingsUpdateInput;
        try {
            if (!openData) throw new Error('open data is off');
            const fetched = await openData.surroundings(boundary);
            data = {
                status: 'ready',
                source: fetched.source,
                fetchedAt: new Date(),
                error: null,
                civilianAreas: fetched.civilianAreas,
                roads: fetched.roads,
                safeZones: fetched.safeZones,
                stations: fetched.stations,
            };
        } catch (err) {
            data = { status: 'failed', error: message(err) };
        }
        if (latest.get(zoneId) !== refresh) return;
        latest.delete(zoneId);
        await orMissing(db.zoneSurroundings.update({ where: { zoneId }, data }));
    }

    const surroundings: Surroundings = {
        async refresh(zoneId, boundary) {
            const refresh = ++refreshes;
            latest.set(zoneId, refresh);
            const row = await db.zoneSurroundings.upsert({
                where: { zoneId },
                create: {
                    zoneId,
                    status: 'pending',
                    source: '',
                    civilianAreas: [],
                    roads: [],
                    safeZones: [],
                    stations: [],
                },
                update: { status: 'pending', error: null },
            });
            fetchAndStore(zoneId, boundary, refresh).catch((err: unknown) =>
                log.error({ err }, `zone ${zoneId}: storing surroundings failed`),
            );
            return row;
        },
        refreshLater(zoneId, boundary) {
            surroundings
                .refresh(zoneId, boundary)
                .catch((err: unknown) =>
                    log.error({ err }, `zone ${zoneId}: surroundings refresh failed`),
                );
        },
    };
    return surroundings;
}
