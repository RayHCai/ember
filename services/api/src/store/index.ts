import type {
    Approval,
    Civilian,
    CivilianMessage,
    DetectionRecord,
    EdgeServerSite,
    FieldReport,
    Incident,
    IncidentEvent,
    PlannerJob,
    PlannerResult,
    Responder,
    ResponderAssignment,
    ResponderMessage,
    RiskZoneRecord,
    Road,
    RoadObservation,
    Scan,
    WatchZone,
    WatchZoneId,
    ZoneGeography,
} from '@ember/contracts';
import {
    MemoryCollection,
    MemoryCounters,
    SqlCollection,
    SqlCounters,
    type Collection,
    type Counters,
    type Sql,
} from './collection.js';

export type StoredGeography = Omit<ZoneGeography, 'roads'> & { zoneId: WatchZoneId; roads: Road[] };

export type StoredEdgeServer = EdgeServerSite & {
    zoneId: WatchZoneId;
    name: string;
    registeredAt: string;
};

export type PairingCodeRecord = {
    token: string;
    zoneId: WatchZoneId;
    responderId: string | null;
    expiresAt: string;
};

export type ResponderSessionRecord = {
    sessionToken: string;
    responderId: string;
    zoneId: WatchZoneId;
    createdAt: string;
};

export class DuplicateError extends Error {}

export type CivilianFilter = { zoneId?: string; civilianAreaId?: string; email?: string };

export type CivilianPatch = Partial<
    Pick<Civilian, 'civilianAreaId' | 'zoneId' | 'location' | 'notes'>
>;

/** Civilians keep their own table: contact-collector's unique email lives there. */
export interface CivilianStore {
    /** Throws `DuplicateError` when the email is registered. */
    create(data: { email: string; zipCode: string }): Promise<Civilian>;
    get(id: string): Promise<Civilian | null>;
    update(id: string, patch: CivilianPatch): Promise<Civilian | null>;
    list(filter: CivilianFilter): Promise<Civilian[]>;
}

export type Store = {
    civilians: CivilianStore;
    counters: Counters;
    zones: Collection<WatchZone>;
    geography: Collection<StoredGeography>;
    roadObservations: Collection<RoadObservation>;
    detections: Collection<DetectionRecord>;
    riskZones: Collection<RiskZoneRecord>;
    edgeServers: Collection<StoredEdgeServer>;
    scans: Collection<Scan>;
    plannerJobs: Collection<PlannerJob>;
    plannerResults: Collection<PlannerResult>;
    incidents: Collection<Incident>;
    incidentEvents: Collection<IncidentEvent>;
    approvals: Collection<Approval>;
    civilianMessages: Collection<CivilianMessage>;
    responders: Collection<Responder>;
    assignments: Collection<ResponderAssignment>;
    responderMessages: Collection<ResponderMessage>;
    pairingCodes: Collection<PairingCodeRecord>;
    sessions: Collection<ResponderSessionRecord>;
    reports: Collection<FieldReport>;
};

type Tables = Omit<Store, 'civilians' | 'counters'>;

type Spec<K extends keyof Tables> =
    Tables[K] extends Collection<infer T>
        ? { table: string; key: keyof T & string; zone: (keyof T & string) | null }
        : never;

/** Table name, key field and the field indexed as `zone_id`, per collection. */
export const TABLES: { [K in keyof Tables]: Spec<K> } = {
    zones: { table: 'watch_zones', key: 'id', zone: 'id' },
    geography: { table: 'zone_geography', key: 'zoneId', zone: 'zoneId' },
    roadObservations: { table: 'road_observations', key: 'id', zone: 'zoneId' },
    detections: { table: 'detections', key: 'id', zone: 'zoneId' },
    riskZones: { table: 'risk_zones', key: 'id', zone: 'zoneId' },
    edgeServers: { table: 'edge_servers', key: 'edgeServerId', zone: 'zoneId' },
    scans: { table: 'scans', key: 'runId', zone: 'zoneId' },
    plannerJobs: { table: 'planner_jobs', key: 'jobId', zone: 'zoneId' },
    plannerResults: { table: 'planner_results', key: 'jobId', zone: 'zoneId' },
    incidents: { table: 'incidents', key: 'id', zone: 'zoneId' },
    incidentEvents: { table: 'incident_events', key: 'id', zone: null },
    approvals: { table: 'approvals', key: 'id', zone: 'zoneId' },
    civilianMessages: { table: 'civilian_messages', key: 'id', zone: null },
    responders: { table: 'responders', key: 'id', zone: 'zoneId' },
    assignments: { table: 'responder_assignments', key: 'id', zone: 'zoneId' },
    responderMessages: { table: 'responder_messages', key: 'id', zone: 'zoneId' },
    pairingCodes: { table: 'responder_pairing_codes', key: 'token', zone: 'zoneId' },
    sessions: { table: 'responder_sessions', key: 'sessionToken', zone: 'zoneId' },
    reports: { table: 'field_reports', key: 'id', zone: 'zoneId' },
};

function build(make: <T extends object>(spec: Spec<keyof Tables>) => Collection<T>): Tables {
    return Object.fromEntries(
        Object.entries(TABLES).map(([name, spec]) => [name, make(spec as Spec<keyof Tables>)]),
    ) as Tables;
}

export class MemoryCivilians implements CivilianStore {
    private readonly rows = new Map<string, Civilian>();
    private number = 0;

    async create(data: { email: string; zipCode: string }) {
        if ([...this.rows.values()].some((c) => c.email === data.email)) throw new DuplicateError();
        const civilian: Civilian = {
            id: crypto.randomUUID(),
            number: ++this.number,
            email: data.email,
            zipCode: data.zipCode,
            civilianAreaId: null,
            zoneId: null,
            location: null,
            notes: null,
            createdAt: new Date().toISOString(),
        };
        this.rows.set(civilian.id, civilian);
        return structuredClone(civilian);
    }

    async get(id: string) {
        const row = this.rows.get(id);
        return row ? structuredClone(row) : null;
    }

    async update(id: string, patch: CivilianPatch) {
        const row = this.rows.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        return structuredClone(row);
    }

    async list(filter: CivilianFilter) {
        return [...this.rows.values()]
            .filter(
                (c) =>
                    (filter.zoneId === undefined || c.zoneId === filter.zoneId) &&
                    (filter.civilianAreaId === undefined ||
                        c.civilianAreaId === filter.civilianAreaId) &&
                    (filter.email === undefined || c.email === filter.email),
            )
            .toSorted((a, b) => a.number - b.number)
            .map((c) => structuredClone(c));
    }
}

export function memoryStore(): Store {
    return {
        civilians: new MemoryCivilians(),
        counters: new MemoryCounters(),
        ...build((spec) => new MemoryCollection(spec.key as never)),
    };
}

export function sqlStore(sql: Sql, civilians: CivilianStore): Store {
    return {
        civilians,
        counters: new SqlCounters(sql),
        ...build(
            (spec) => new SqlCollection(sql, spec.table, spec.key as never, spec.zone as never),
        ),
    };
}
