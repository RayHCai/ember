import { getTelemetry, isAirborne } from '../live/telemetry';
import type { ZoneView } from '../model/types';
import { coveragePct, deployed, hectares, riskTotals } from '../model/zone';
import {
    DEFAULT_RADIUS_M,
    runPlanner,
    startScan,
    stopScan,
    suggestPlacements,
} from '../store/actions';
import { useUi, type BlastDraft } from '../store/ui';
import { zoneViewNow } from '../store/zones';

// The agent panel's commands: plain-language requests mapped onto the same api actions the panel
// buttons take. Civilian texts only ever come back as drafts for the operator to approve.

export interface ToolCall {
    name: string;
    args: string;
}

export interface AgentReply {
    text: string;
    tools: ToolCall[];
    draft?: BlastDraft;
}

const has = (text: string, ...words: string[]) => words.some((w) => text.includes(w));

function fleetLine(zone: ZoneView): string {
    const airborne = zone.drones.filter((d) => isAirborne(getTelemetry(d.id))).length;
    const silent = zone.drones.filter((d) => !getTelemetry(d.id)).length;
    const servers = deployed(zone);
    const offline = servers.filter((s) => s.online === false).map((s) => s.name);
    return `${airborne} of ${zone.drones.length} drones airborne${silent ? `, ${silent} not reporting` : ''}. ${servers.length - offline.length} of ${servers.length} edge servers online${offline.length ? `; ${offline.join(', ')} offline` : ''}.`;
}

function summary(zone: ZoneView): string {
    const t = riskTotals(zone.riskZones);
    const fire = t.onFire
        ? `Active fire across ${hectares(t.onFireHa)} ha in ${t.onFire} area${t.onFire === 1 ? '' : 's'}.`
        : t.atRisk
          ? `No fire. ${hectares(t.atRiskHa)} ha flagged at risk.`
          : 'No fire and no risk flagged.';
    const scan = zone.scan
        ? ` A scan is running, ${Math.round(zone.scan.coverage * 100)}% done.`
        : '';
    const plan = zone.plan
        ? ` The latest plan has ${zone.plan.attackZones.length} attack zones and ${zone.plan.evacuationRoutes.length} evacuation routes.`
        : '';
    const waiting = zone.blasts.filter((b) => b.state === 'pending_approval').length;
    return `${zone.name}: ${fire} ${fleetLine(zone)}${scan}${plan}${waiting ? ` ${waiting} blast${waiting === 1 ? '' : 's'} wait for your approval.` : ''}`;
}

export async function respond(zoneId: string, input: string): Promise<AgentReply> {
    const zone = zoneViewNow(zoneId);
    if (!zone) return { text: 'That watch zone is gone.', tools: [] };
    const text = input.toLowerCase();

    if (has(text, 'text', 'sms', 'evacuat', 'blast', 'alert', 'notify', 'message', 'tell')) {
        const responders = has(text, 'responder', 'crew', 'engine', 'firefighter');
        const civilians = has(
            text,
            'everyone',
            'civilian',
            'resident',
            'people',
            'public',
            'evacuat',
        );
        const audience = responders && civilians ? 'both' : responders ? 'responders' : 'civilians';
        const near = has(text, 'within', 'near', 'around', 'mi of', 'km of');
        const route = /route\s*(\d+)/i.exec(input)?.[0];
        const firstRoute = zone.plan?.evacuationRoutes.find((r) => r.status !== 'no_safe_route');
        const safe = zone.surroundings?.safeZones.find(
            (s) => s.id === firstRoute?.destination?.safeZoneId,
        );
        const evacuate = has(text, 'evacuat', 'leave', 'get out');
        const draft: BlastDraft = {
            audience,
            priority: evacuate ? 'critical' : 'urgent',
            title: evacuate ? 'Evacuate now' : 'Wildfire update',
            body: evacuate
                ? `Ember alert: a wildfire is moving toward your area. Evacuate now${route ? ` via ${route}` : ' by the marked route'} to ${safe?.name ?? 'the nearest safe zone'}. Reply SAFE once you are out.`
                : `Ember update: crews are working a fire in ${zone.name}. Stay ready to leave. Reply with questions any time.`,
            area: near ? 'near_fire' : 'zone',
        };
        return {
            text:
                audience === 'responders'
                    ? 'Drafted a message to responders. Review it and send when ready.'
                    : `Drafted an ${evacuate ? 'evacuation' : 'update'} text for civilians${near ? ' near the fire' : ''}. Nothing goes to civilians until you approve it.`,
            tools: [
                { name: 'draft_event_blast', args: `audience: ${audience}, area: ${draft.area}` },
            ],
            draft,
        };
    }

    if (has(text, 'stop', 'recall', 'abort', 'land')) {
        if (!zone.scan) return { text: 'No scan is running.', tools: [] };
        await stopScan(zoneId, zone.scan.runId);
        return {
            text: `Recalling the fleet over ${zone.name}. They fly back to their edge servers and land.`,
            tools: [{ name: 'stop_scan', args: `run: ${zone.scan.runId}` }],
        };
    }

    if (has(text, 'scan', 'survey', 'fly', 'launch', 'sweep')) {
        const scan = await startScan(zoneId);
        const tools = [{ name: 'start_scan', args: `zone: ${zone.name}` }];
        if (!scan) return { text: 'The scan did not start; the notice says why.', tools };
        if (scan.state === 'failed')
            return { text: `The scan failed: ${scan.error ?? 'no reason given'}.`, tools };
        useUi.getState().setMode('detection');
        const drones = scan.results.flatMap((r) => (r.ok ? r.drones : [])).length;
        return {
            text: `Launched ${drones} drone${drones === 1 ? '' : 's'} over ${zone.name}. I switched the map to Detection so you can watch it fill in.`,
            tools,
        };
    }

    if (has(text, 'gap', 'coverage', 'blind')) {
        const pct = coveragePct(zone);
        useUi.getState().showGaps();
        if (pct < 90) {
            const result = await suggestPlacements(
                zoneId,
                deployed(zone)[0]?.radiusM ?? DEFAULT_RADIUS_M,
            );
            const n = result?.placements.length ?? 0;
            return {
                text: `Coverage is ${pct}%, under the 90% target. Uncovered ground is shaded on the map, and I planned ${n} site${n === 1 ? '' : 's'} (flashing) that lift it to ${Math.round((result?.projectedCoverage ?? 0) * 100)}%.`,
                tools: [
                    { name: 'query_coverage', args: `zone: ${zone.name}` },
                    { name: 'suggest_placements', args: 'target: 92%' },
                ],
            };
        }
        return {
            text: `Coverage is ${pct}%. The uncovered cells are shaded on the map for a few seconds.`,
            tools: [{ name: 'query_coverage', args: `zone: ${zone.name}` }],
        };
    }

    if (has(text, 'planner', 'plan', 'path', 'route', 'predict', 'spread')) {
        await runPlanner(zoneId);
        return {
            text: 'Running the civilian and responder planners. Results land in the Suggestions overlay when the job finishes.',
            tools: [{ name: 'run_planner', args: `zone: ${zone.name}` }],
        };
    }

    if (has(text, 'health', 'drone', 'server', 'battery', 'fleet')) {
        return {
            text: fleetLine(zone),
            tools: [{ name: 'query_fleet_health', args: `zone: ${zone.name}` }],
        };
    }

    if (has(text, 'summar', 'status', 'brief', 'happen', 'overview', 'update')) {
        return {
            text: summary(zone),
            tools: [{ name: 'summarize_zone', args: `zone: ${zone.name}` }],
        };
    }

    return {
        text: 'I can run or stop a scan, show coverage gaps, run the civilian and responder planners, summarize the zone, check fleet health, and draft event blasts for your approval. Try "run a scan now".',
        tools: [],
    };
}
