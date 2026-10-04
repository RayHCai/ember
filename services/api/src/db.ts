import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

export function createPrisma(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type Db = Pick<
    PrismaClient,
    | 'civilian'
    | 'operator'
    | 'operatorSession'
    | 'watchZone'
    | 'edgeServer'
    | 'edgeServerPlacement'
    | 'drone'
    | 'scan'
    | 'mappingRun'
    | 'detectionFrame'
    | 'zoneSurroundings'
    | 'plannerJob'
    | 'blast'
    | '$transaction'
>;

/** P2002 unique, P2003 foreign key, P2025 record to update or delete is missing. */
export function isDbError(err: unknown, code: 'P2002' | 'P2003' | 'P2025'): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}
