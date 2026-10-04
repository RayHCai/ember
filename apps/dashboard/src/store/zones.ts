import { create } from 'zustand';
import { dockFleet } from '../sim/fleet';
import { makeGrid, polygonAreaKm2 } from '../sim/geo';
import { seedZones } from '../sim/seed';
import type {
    Blast,
    CivilianPlan,
    CivilianReport,
    Drone,
    EdgeServer,
    LatLon,
    Responder,
    ResponderPlan,
    Schedule,
    WatchZone,
} from '../sim/types';
import { buildZone, newId, renameServer } from '../sim/world';

// Watch zones and every operator action on them, answered by built-in dummy data.

type Patch = Partial<WatchZone> | ((zone: WatchZone) => Partial<WatchZone>);

interface ZonesState {
    zones: Record<string, WatchZone>;
    order: string[];
    update: (id: string, patch: Patch) => void;
    createZone: (input: { name: string; region: string; boundary: LatLon[] }) => string;
    setBoundary: (id: string, boundary: LatLon[]) => void;
    rename: (id: string, name: string) => void;
    setPendingServers: (id: string, servers: EdgeServer[]) => void;
    clearPending: (id: string) => void;
    moveServer: (id: string, serverId: string, at: LatLon) => void;
    deployServer: (id: string, serverId: string) => void;
    addDrone: (id: string, drone: Drone) => void;
    setSchedule: (id: string, patch: Partial<Schedule>) => void;
    setPlanning: (id: string, kind: 'civilian' | 'responder', running: boolean) => void;
    setCivilianPlan: (id: string, plan: CivilianPlan) => void;
    setResponderPlan: (id: string, plan: ResponderPlan) => void;
    setReportStatus: (id: string, reportId: string, status: CivilianReport['status']) => void;
    addResponder: (id: string, responder: Responder) => void;
    addBlast: (id: string, blast: Blast) => void;
    /** Marks the risk map changed after an in-place update. */
    touchRisk: (id: string) => void;
}

const seeded = seedZones();
for (const zone of seeded) dockFleet(zone);

export const useZones = create<ZonesState>()((set, get) => {
    const update = (id: string, patch: Patch) =>
        set((s) => {
            const zone = s.zones[id];
            if (!zone) return {};
            const changes = typeof patch === 'function' ? patch(zone) : patch;
            return { zones: { ...s.zones, [id]: { ...zone, ...changes } } };
        });

    return {
        zones: Object.fromEntries(seeded.map((z) => [z.id, z])),
        order: seeded.map((z) => z.id),
        update,

        createZone: ({ name, region, boundary }) => {
            const id = `${
                name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '')
                    .slice(0, 24) || 'zone'
            }-${Date.now().toString(36).slice(-4)}`;
            const zone = buildZone({ id, name, region, boundary });
            set((s) => ({ zones: { ...s.zones, [id]: zone }, order: [id, ...s.order] }));
            return id;
        },

        setBoundary: (id, boundary) =>
            update(id, (z) => {
                const grid = makeGrid(boundary);
                return {
                    boundary,
                    grid,
                    areaKm2: Math.round(polygonAreaKm2(boundary) * 10) / 10,
                    risk: new Uint8Array(grid.rows * grid.cols),
                    riskVersion: z.riskVersion + 1,
                    servers: z.servers.filter((s) => s.status === 'deployed'),
                    civilianPlan: null,
                    responderPlan: null,
                };
            }),

        rename: (id, name) => update(id, { name }),

        setPendingServers: (id, servers) =>
            update(id, (z) => ({
                servers: [...z.servers.filter((s) => s.status === 'deployed'), ...servers],
            })),

        clearPending: (id) =>
            update(id, (z) => ({ servers: z.servers.filter((s) => s.status === 'deployed') })),

        moveServer: (id, serverId, [lat, lon]) =>
            update(id, (z) => ({
                servers: z.servers.map((s) =>
                    s.id === serverId ? renameServer(z, { ...s, lat, lon }) : s,
                ),
            })),

        deployServer: (id, serverId) =>
            update(id, (z) => ({
                servers: z.servers.map((s) =>
                    s.id === serverId ? { ...s, status: 'deployed' as const } : s,
                ),
            })),

        addDrone: (id, drone) => update(id, (z) => ({ drones: [...z.drones, drone] })),

        setSchedule: (id, patch) =>
            update(id, (z) => {
                const schedule = { ...z.schedule, ...patch };
                schedule.nextAt = schedule.enabled
                    ? Date.now() + schedule.everyHours * 3_600_000
                    : null;
                return { schedule };
            }),

        setPlanning: (id, kind, running) =>
            update(id, (z) => ({ planning: { ...z.planning, [kind]: running } })),
        setCivilianPlan: (id, civilianPlan) => update(id, { civilianPlan }),
        setResponderPlan: (id, responderPlan) => update(id, { responderPlan }),

        setReportStatus: (id, reportId, status) =>
            update(id, (z) => ({
                reports: z.reports.map((r) => (r.id === reportId ? { ...r, status } : r)),
            })),

        addResponder: (id, responder) =>
            update(id, (z) => ({ responders: [...z.responders, responder] })),

        addBlast: (id, blast) => update(id, (z) => ({ blasts: [blast, ...z.blasts] })),

        touchRisk: (id) => {
            if (get().zones[id]) update(id, (z) => ({ riskVersion: z.riskVersion + 1 }));
        },
    };
});

export function blastId(): string {
    return newId('bl');
}
