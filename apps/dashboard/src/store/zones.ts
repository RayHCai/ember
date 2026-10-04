import type { EdgeServer, WatchZoneSummary } from '@ember/contracts';
import { create } from 'zustand';
import type { ZoneRecords, ZoneView } from '../model/types';
import { zoneView } from '../model/zone';

// The api's records as last fetched: the zone list, and every resource of the zones opened.
// `store/sync.ts` keeps them fresh; `store/actions.ts` changes them.

type Patch = Partial<ZoneRecords> | ((records: ZoneRecords) => Partial<ZoneRecords>);

interface ZonesState {
    summaries: WatchZoneSummary[] | null;
    listError: string | null;
    records: Record<string, ZoneRecords>;
    /** Zones the api no longer has. */
    missing: Record<string, true>;
    /** Registered edge servers that no zone has yet. */
    unassigned: EdgeServer[];
    /** False while the api cannot be reached. */
    reachable: boolean;
    patch: (zoneId: string, patch: Patch) => void;
}

export const useZones = create<ZonesState>()((set) => ({
    summaries: null,
    listError: null,
    records: {},
    missing: {},
    unassigned: [],
    reachable: true,
    patch: (zoneId, patch) =>
        set((s) => {
            const r = s.records[zoneId];
            if (!r) return {};
            const changes = typeof patch === 'function' ? patch(r) : patch;
            return { records: { ...s.records, [zoneId]: { ...r, ...changes } } };
        }),
}));

/** The zone's view, or undefined until its records load. */
export function useZoneView(zoneId: string | null): ZoneView | undefined {
    const records = useZones((s) => (zoneId ? s.records[zoneId] : undefined));
    return records ? zoneView(records) : undefined;
}

export function zoneViewNow(zoneId: string): ZoneView | undefined {
    const r = useZones.getState().records[zoneId];
    return r ? zoneView(r) : undefined;
}
