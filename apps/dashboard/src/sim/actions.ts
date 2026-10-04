import { notify } from '../store/notifications';
import type { BlastDraft } from '../store/ui';
import { blastId, useZones } from '../store/zones';
import { dockDrone } from './fleet';
import { civilianPlan, responderPlan } from './planners';
import type { ApprovalRecord, Blast, Drone } from './types';
import { pairDrone, suggestServers } from './world';

// Operator actions that take time, answered by the dummy backend.

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function suggestPlacements(zoneId: string): number {
    const zone = useZones.getState().zones[zoneId];
    if (!zone) return 0;
    const servers = suggestServers(zone);
    useZones.getState().setPendingServers(zoneId, servers);
    return servers.length;
}

/** Deploys pending servers one at a time, as each connects to the primary. */
export async function deployPending(zoneId: string, gapMs = 650): Promise<void> {
    const pending =
        useZones.getState().zones[zoneId]?.servers.filter((s) => s.status === 'pending') ?? [];
    for (const server of pending) {
        await wait(gapMs);
        useZones.getState().deployServer(zoneId, server.id);
    }
    const zone = useZones.getState().zones[zoneId];
    if (zone && pending.length) {
        notify(
            'success',
            'Edge servers deployed',
            `${pending.length} servers joined the ${zone.name} network.`,
            zone,
        );
    }
}

/** A drone placed near an edge server joins its fleet. */
export function pairNextDrone(zoneId: string): Drone | null {
    const zone = useZones.getState().zones[zoneId];
    const servers = zone?.servers.filter((s) => s.status === 'deployed') ?? [];
    if (!zone || servers.length === 0) return null;
    const server = [...servers].sort(
        (a, b) =>
            zone.drones.filter((d) => d.serverId === a.id).length -
            zone.drones.filter((d) => d.serverId === b.id).length,
    )[0]!;
    const drone = pairDrone(zone, server);
    useZones.getState().addDrone(zoneId, drone);
    const updated = useZones.getState().zones[zoneId]!;
    dockDrone(updated, drone, 100);
    return drone;
}

export async function runPlanner(zoneId: string, kind: 'civilian' | 'responder'): Promise<void> {
    const store = useZones.getState();
    if (!store.zones[zoneId] || store.zones[zoneId]!.planning[kind]) return;
    store.setPlanning(zoneId, kind, true);
    await wait(kind === 'civilian' ? 2200 : 1900);
    const zone = useZones.getState().zones[zoneId];
    if (!zone) return;
    if (kind === 'civilian') useZones.getState().setCivilianPlan(zoneId, civilianPlan(zone));
    else useZones.getState().setResponderPlan(zoneId, responderPlan(zone));
    useZones.getState().setPlanning(zoneId, kind, false);
    notify(
        'success',
        kind === 'civilian' ? 'Civilian path plan ready' : 'Responder path plan ready',
        'Open the Suggestions overlay to see it on the map.',
        zone,
    );
}

export function subscribedCivilians(zoneId: string, area: BlastDraft['area']): number {
    const zone = useZones.getState().zones[zoneId];
    if (!zone) return 0;
    const all =
        zone.checkIns.total ||
        Math.round(zone.communities.reduce((s, c) => s + c.population, 0) * 0.012);
    return area === 'near_fire' ? Math.round(all * 0.38) : all;
}

/**
 * Sends a blast. Civilian audiences require an approval record: there is no
 * code path that texts civilians without one.
 */
export function sendBlast(
    zoneId: string,
    draft: BlastDraft,
    approval: ApprovalRecord | null,
): Blast {
    const zone = useZones.getState().zones[zoneId];
    if (!zone) throw new Error(`zone ${zoneId}: not found`);
    const civilians = draft.audience !== 'responders';
    if (civilians && !approval)
        throw new Error(`zone ${zoneId}: civilian alerts need an operator approval`);
    const blast: Blast = {
        id: blastId(),
        ...draft,
        recipients: {
            civilians: civilians ? subscribedCivilians(zoneId, draft.area) : 0,
            responders: draft.audience !== 'civilians' ? zone.responders.length : 0,
        },
        sentAt: Date.now(),
        approval: civilians ? approval : null,
    };
    useZones.getState().addBlast(zoneId, blast);
    const parts = [
        blast.recipients.civilians ? `${blast.recipients.civilians} civilians` : '',
        blast.recipients.responders ? `${blast.recipients.responders} responders` : '',
    ].filter(Boolean);
    notify(
        'success',
        'Event blast sent',
        `"${draft.title}" to ${parts.join(' and ')}.`,
        zone,
        blast.recipients.responders,
    );
    return blast;
}
