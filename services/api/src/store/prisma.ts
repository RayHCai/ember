import type { Civilian, LatLng, WatchZoneId } from '@ember/contracts';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { Sql } from './collection.js';
import {
    DuplicateError,
    sqlStore,
    type CivilianFilter,
    type CivilianPatch,
    type CivilianStore,
    type Store,
} from './index.js';

type CivilianRow = Awaited<ReturnType<PrismaClient['civilian']['create']>>;

function toCivilian(row: CivilianRow): Civilian {
    return {
        id: row.id,
        number: row.number,
        email: row.email,
        zipCode: row.zipCode,
        civilianAreaId: row.civilianAreaId,
        zoneId: row.zoneId as WatchZoneId | null,
        location: (row.location as LatLng | null) ?? null,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
    };
}

export class PrismaCivilians implements CivilianStore {
    constructor(private readonly prisma: Pick<PrismaClient, 'civilian'>) {}

    async create(data: { email: string; zipCode: string }) {
        try {
            return toCivilian(await this.prisma.civilian.create({ data }));
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new DuplicateError(data.email);
            }
            throw err;
        }
    }

    async get(id: string) {
        const row = await this.prisma.civilian.findUnique({ where: { id } });
        return row ? toCivilian(row) : null;
    }

    async update(id: string, patch: CivilianPatch) {
        const { location, ...rest } = patch;
        try {
            const row = await this.prisma.civilian.update({
                where: { id },
                data: {
                    ...rest,
                    ...(location === undefined
                        ? {}
                        : { location: location === null ? Prisma.DbNull : location }),
                },
            });
            return toCivilian(row);
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
                return null;
            }
            throw err;
        }
    }

    async list(filter: CivilianFilter) {
        const rows = await this.prisma.civilian.findMany({
            where: filter,
            orderBy: { number: 'asc' },
        });
        return rows.map(toCivilian);
    }
}

export function prismaSql(prisma: PrismaClient): Sql {
    return {
        query: <R>(text: string, params: unknown[]) => prisma.$queryRawUnsafe<R[]>(text, ...params),
    };
}

export function prismaStore(prisma: PrismaClient): Store {
    return sqlStore(prismaSql(prisma), new PrismaCivilians(prisma));
}
