import type { AgentCard, AgentChatReply, AgentChatRequest } from '@ember/contracts';
import type { ZoneStatus } from './incidents.js';

const HELP =
    "I watch Ember's zones for fire. When drones find one I request a plan, post where responders " +
    'should stage, and draft evacuation texts per ZIP for an operator to approve in the dashboard; ' +
    'approved texts go to everyone signed up in that ZIP. Ask "status", or name a zone.';

const point = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

function cards(s: ZoneStatus): AgentCard[] {
    const out: AgentCard[] = [
        {
            kind: 'incident',
            title: `Fire in ${s.zone.name}`,
            markdown:
                `${s.onFire} area${s.onFire === 1 ? '' : 's'} on fire since ${s.since}. ` +
                `Plan: ${s.plan ? s.plan.state : 'not requested yet'}.`,
            data: { zoneId: s.zone.id, onFire: s.onFire, since: s.since, plan: s.plan },
        },
    ];
    if (s.responders.length) {
        out.push({
            kind: 'responder_plan',
            title: 'Where responders should stage',
            markdown: s.responders
                .map(
                    (z) =>
                        `${z.rank}. ${z.tactic} attack, drop site ${point(z.dropSite)}, ` +
                        `${Math.round(z.radiusM)} m radius, fire in ~${Math.round(z.fireArrivalMin)} min` +
                        (z.protects.length
                            ? `, protects ${z.protects.slice(0, 3).join(', ')}`
                            : ''),
                )
                .join('\n'),
            data: s.responders,
        });
    }
    if (s.evacuations.length || s.unplaced.length) {
        const lines = s.evacuations.map((e) => {
            const state = e.delivered
                ? `sent to ${e.delivered.sent}${e.delivered.failed ? `, ${e.delivered.failed} failed` : ''}`
                : e.state === 'pending_approval'
                  ? 'waiting for operator approval'
                  : 'approved, sending';
            return `- ZIP ${e.zipCode}: ${state}`;
        });
        if (s.unplaced.length)
            lines.push(`- No ZIP found for ${s.unplaced.join(', ')}: not drafted`);
        out.push({
            kind: 'evacuation',
            title: 'Evacuation alerts',
            markdown: lines.join('\n'),
            data: s.evacuations,
        });
    }
    return out;
}

/** Answers from what the incident loop last saw; chat never acts. */
export function answer(req: AgentChatRequest, statuses: ZoneStatus[]): AgentChatReply {
    const text = req.text.trim().toLowerCase();
    if (/^(help|\?|hi|hello)\b/.test(text)) return { text: HELP, cards: [] };
    const named = statuses.filter((s) => text.includes(s.zone.name.toLowerCase()));
    const scope = named.length ? named : statuses;
    if (!scope.length) return { text: 'Ember is not watching any zone yet.', cards: [] };
    const burning = scope.filter((s) => s.onFire > 0);
    if (!burning.length) {
        const zones = scope.map((s) => s.zone.name).join(', ');
        return { text: `No fire detected in ${zones}.`, cards: [] };
    }
    return {
        text: `Fire detected in ${burning.map((s) => s.zone.name).join(', ')}.`,
        cards: burning.flatMap(cards),
    };
}
