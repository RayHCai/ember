import { useUi, type BlastDraft } from '../store/ui';
import { useZones } from '../store/zones';
import { runPlanner, subscribedCivilians, suggestPlacements } from './actions';
import { getTelemetry } from './live';
import { isScanning, startScan, stopScan } from './scan';
import { deployedCoverage, riskCounts } from './world';

// The Operator Agent, answered by the dummy backend. It calls the same actions the
// UI does, and outbound civilian texts only ever come back as drafts for approval.

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

function fleetLine(zoneId: string): string {
    const zone = useZones.getState().zones[zoneId]!;
    const states = zone.drones.map((d) => getTelemetry(d.id)?.state ?? 'docked');
    const airborne = states.filter(
        (s) => s === 'scanning' || s === 'launching' || s === 'returning',
    ).length;
    const charging = states.filter((s) => s === 'charging').length;
    const deployed = zone.servers.filter((s) => s.status === 'deployed');
    const hot = deployed.filter((s) => s.health.temperatureC > 42).map((s) => s.name);
    return `${airborne} of ${zone.drones.length} drones airborne, ${charging} charging. ${deployed.length} edge servers online${hot.length ? `; ${hot.join(', ')} running warm` : ', all healthy'}.`;
}

function summary(zoneId: string): string {
    const zone = useZones.getState().zones[zoneId]!;
    const { onFire, atRisk } = riskCounts(zone);
    const fire = onFire
        ? `Active fire across about ${Math.round(onFire)} ha.`
        : atRisk
          ? `No fire. ${atRisk} ha flagged at risk.`
          : 'No fire and no risk flagged.';
    const unread = zone.reports.filter((r) => r.status === 'new').length;
    const checkIns = zone.checkIns.total
        ? ` ${zone.checkIns.safe} of ${zone.checkIns.total} civilians have checked in SAFE.`
        : '';
    return `${zone.name}: ${fire} ${fleetLine(zoneId)}${checkIns} ${unread ? `${unread} civilian reports need verification.` : 'No unread civilian reports.'}`;
}

export function respond(zoneId: string, input: string): AgentReply {
    const zone = useZones.getState().zones[zoneId];
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
        const route =
            /route\s*(\d+)/i.exec(input)?.[0] ??
            zone.civilianPlan?.routes[0]?.name ??
            'the marked route';
        const safe =
            zone.safeZones.find((s) => s.id === zone.civilianPlan?.routes[0]?.safeZoneId) ??
            zone.safeZones[0];
        const evacuate = has(text, 'evacuat', 'leave', 'get out');
        const draft: BlastDraft = {
            audience,
            priority: evacuate ? 'critical' : 'urgent',
            title: evacuate ? 'Evacuate now' : 'Wildfire update',
            body: evacuate
                ? `Ember alert: a wildfire is moving toward your area. Evacuate now via ${route} to ${safe?.name ?? 'the nearest safe zone'}. Reply SAFE once you are out.`
                : `Ember update: crews are working a fire in ${zone.name}. Stay ready to leave. Reply with questions any time.`,
            area: near ? 'near_fire' : 'zone',
        };
        const count =
            audience === 'responders'
                ? zone.responders.length
                : subscribedCivilians(zoneId, draft.area);
        return {
            text:
                audience === 'responders'
                    ? `Drafted a message to ${count} responders. Review it and send when ready.`
                    : `Drafted an ${evacuate ? 'evacuation' : 'update'} text for about ${count} subscribed civilians${near ? ' near the fire' : ''}. Nothing goes to civilians until you approve it.`,
            tools: [
                { name: 'draft_event_blast', args: `audience: ${audience}, area: ${draft.area}` },
            ],
            draft,
        };
    }

    if (has(text, 'stop', 'recall', 'abort', 'land')) {
        if (!isScanning(zoneId))
            return { text: 'No scan is running, so every drone is already home.', tools: [] };
        stopScan(zoneId);
        return {
            text: `Recalling the fleet over ${zone.name}. They will be docked in a few seconds.`,
            tools: [{ name: 'stop_scan', args: `zone: ${zone.name}` }],
        };
    }

    if (has(text, 'scan', 'survey', 'fly', 'launch', 'sweep')) {
        const problem = startScan(zoneId);
        if (problem)
            return { text: problem, tools: [{ name: 'start_scan', args: `zone: ${zone.name}` }] };
        useUi.getState().setMode('detection');
        return {
            text: `Launched ${zone.drones.length} drones over ${zone.name}. I switched the map to Detection so you can watch it fill in, and I will flag anything at risk or burning.`,
            tools: [{ name: 'start_scan', args: `zone: ${zone.name}, mode: manual` }],
        };
    }

    if (has(text, 'gap', 'coverage', 'blind')) {
        const pct = deployedCoverage(zone);
        useUi.getState().showGaps();
        if (pct < 90) {
            const n = suggestPlacements(zoneId);
            return {
                text: `Coverage is ${pct}%, under the 90% target. Uncovered ground is shaded on the map, and I suggested ${n} edge server placements (flashing). Deploy them from the operator panel.`,
                tools: [
                    { name: 'query_coverage', args: `zone: ${zone.name}` },
                    { name: 'suggest_edge_servers', args: `target: 90%` },
                ],
            };
        }
        return {
            text: `Coverage is ${pct}%. The few uncovered cells are shaded on the map for a few seconds; they sit along the boundary edge.`,
            tools: [{ name: 'query_coverage', args: `zone: ${zone.name}` }],
        };
    }

    if (has(text, 'planner', 'plan', 'path', 'route', 'predict', 'spread')) {
        const civilian = has(text, 'civilian', 'evac', 'resident') || !has(text, 'responder');
        const responder = has(text, 'responder', 'crew', 'drop') || !has(text, 'civilian');
        const tools: ToolCall[] = [];
        if (civilian) {
            void runPlanner(zoneId, 'civilian');
            tools.push({ name: 'run_planner', args: 'kind: civilian' });
        }
        if (responder) {
            void runPlanner(zoneId, 'responder');
            tools.push({ name: 'run_planner', args: 'kind: responder' });
        }
        return {
            text: `Running the ${civilian && responder ? 'civilian and responder planners' : civilian ? 'civilian planner' : 'responder planner'}. Results land in the Suggestions overlay in a couple of seconds.`,
            tools,
        };
    }

    if (has(text, 'report', 'sighting', 'photo')) {
        const unread = zone.reports.filter((r) => r.status === 'new');
        return {
            text: unread.length
                ? `${unread.length} unverified civilian reports: ${unread.map((r) => `"${r.text}"`).join('; ')}. They are pinned on the map; click one to verify it.`
                : 'No unverified civilian reports right now.',
            tools: [{ name: 'list_civilian_reports', args: 'status: new' }],
        };
    }

    if (has(text, 'health', 'drone', 'server', 'battery', 'fleet')) {
        return {
            text: fleetLine(zoneId),
            tools: [{ name: 'query_fleet_health', args: `zone: ${zone.name}` }],
        };
    }

    if (has(text, 'summar', 'status', 'brief', 'happen', 'overview', 'update')) {
        return {
            text: summary(zoneId),
            tools: [{ name: 'summarize_zone', args: `zone: ${zone.name}` }],
        };
    }

    return {
        text: 'I can run or stop a scan, show coverage gaps, run the civilian and responder planners, summarize the zone, check fleet health, and draft event blasts for your approval. Try "run a scan now".',
        tools: [],
    };
}
