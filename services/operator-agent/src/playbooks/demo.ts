import type { WatchZone } from '@ember/contracts';
import { decide, type Ctx } from '../context.js';
import { openIncidents } from './response.js';

/**
 * Puts a zone back where the demo starts: no open incident, no simulated fire, every road open,
 * no scan running. Real drone detections are left alone. Approvals and the decision log are history
 * and stay.
 */
export async function resetDemo(ctx: Ctx, zone: WatchZone, actor: string) {
    const actions: string[] = [];
    for (const incident of await openIncidents(ctx, zone.id)) {
        await ctx.api.updateIncident(incident.id, { state: 'closed' });
        actions.push(`closed Incident #${incident.number}`);
    }
    const simulated = (await ctx.api.detections(zone.id)).filter((d) => d.source === 'simulated');
    const ids = new Set(simulated.map((d) => d.id));
    for (const r of await ctx.api.riskZones(zone.id)) {
        if (r.detectionIds.some((id) => ids.has(id))) {
            await ctx.api.deleteRiskZone(zone.id, r.id);
            actions.push(`removed simulated fire area ${r.id.slice(0, 8)}`);
        }
    }
    for (const d of simulated.filter((x) => x.verification !== 'dismissed')) {
        await ctx.api.verifyDetection(d.id, 'dismissed', actor);
    }
    if (simulated.length) actions.push(`dismissed ${simulated.length} simulated detection(s)`);
    for (const road of (await ctx.api.roads(zone.id)).filter((r) => r.state !== 'open')) {
        await ctx.api.observeRoad(zone.id, {
            roadId: road.id,
            state: 'open',
            source: 'operator',
            reportedBy: actor,
            note: 'demo reset',
            location: null,
        });
        actions.push(`reopened ${road.name ?? road.id}`);
    }
    for (const scan of (await ctx.api.scans(zone.id)).filter((s) => s.state === 'mapping')) {
        await ctx.api.stopScan(scan.runId, actor, 'demo reset');
        actions.push(`stopped scan ${scan.runId.slice(0, 8)}`);
    }
    await ctx.memory.setState(`lastReplan:${zone.id}`, null);
    await decide(ctx, {
        zoneId: zone.id,
        incidentId: null,
        domain: 'prevention',
        kind: 'reset_demo',
        summary: `Reset the ${zone.name} demo`,
        reason: `requested by ${actor}`,
        inputs: [{ kind: 'chat', id: actor, note: 'reset' }],
        confidence: 1,
        actions,
    });
    return actions;
}
