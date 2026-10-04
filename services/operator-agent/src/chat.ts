import type { AgentChatReply, AgentChatRequest } from '@ember/contracts';
import type { OperatorRelay } from './api.js';
import { card } from './cards.js';
import { decide, describeError, type Ctx } from './context.js';
import { route, HELP } from './intents.js';
import { invoke, specs, type Turn } from './tools/registry.js';
import { TOOLS } from './tools/tools.js';

const APPROVAL = /\b(approve|reject)\s+(?:approval\s+)?#?(\d+)\s+(?:code\s+)?([a-z0-9]{4})\b/i;
// ASI:One may forward the user's @mention of the agent along with the text.
const MENTION = /@agent1[a-z0-9]+/gi;
const HISTORY_TURNS = 12;

export type ChatDeps = {
    relay: OperatorRelay;
    /** Treat every sender as an operator. Demo deployments only. */
    openOperator: boolean;
};

const SYSTEM = (
    operator: boolean,
    zones: string,
) => `You are Ember, a wildfire detection and response agent.
You act only through your tools, which call Ember's real services: the api (records, scans, approvals), the planner (fire spread, attack zones, civilian impacts, evacuation routes, sector risk) and the decision log.
Rules:
- Every number, time, place, road, route, perimeter, risk score and assignment you state must come from a tool result in this conversation. Never estimate or invent one. If a tool did not give it, say you do not have it.
- When you explain a plan, say what the planner assumed (its assumptions list) when relevant.
- The planner is a fast screening model. Never present its output as an official evacuation order, and never claim to be or speak for a government agency, fire department or utility.
- Outbound civilian alerts are drafted for operator approval; you cannot approve them. Approval happens only when an operator replies "approve <number> <code>".
- Simulation-only actions (simulate_fire) are labelled as simulation.
- Prefer one composite tool (coordinate_response, update_road_state, rank_regions) over many small calls.
- Be brief: a few sentences. Structured details are shown to the user as cards from the tools, so do not repeat whole tables.
${operator ? 'The user is an Ember operator and may use every tool.' : 'The user is a member of the public: answer questions about wildfire risk only; you cannot take actions.'}
Watch zones: ${zones || 'none yet'}.`;

export class ChatHandler {
    constructor(
        private readonly ctx: Ctx,
        private readonly deps: ChatDeps,
    ) {}

    /** An operator by name: the dashboard, or an allow-listed ASI:One address. */
    isListed(req: AgentChatRequest): boolean {
        return (
            req.channel === 'dashboard' || this.ctx.config.operatorAddresses.includes(req.sender)
        );
    }

    isOperator(req: AgentChatRequest): boolean {
        return this.deps.openOperator || this.isListed(req);
    }

    async handle(req: AgentChatRequest): Promise<AgentChatReply> {
        const { ctx } = this;
        const turn: Turn = {
            actor: `${req.channel}:${req.sender}`,
            operator: this.isOperator(req),
            cards: [],
            toolCalls: [],
            decisionIds: [],
        };
        const listed = this.isListed(req);
        if (!listed) {
            ctx.log.info({ sender: req.sender, channel: req.channel }, 'chat from a non-operator');
        }
        const message = req.text.replace(MENTION, ' ').replace(/\s+/g, ' ').trim();
        const history = await ctx.memory.turns(req.sessionId, HISTORY_TURNS);
        await ctx.memory.appendTurn(req.sessionId, {
            role: 'user',
            text: message,
            at: req.sentAt,
        });

        let text: string;
        const approval = APPROVAL.exec(message);
        if (approval) {
            text = await this.decideApproval(
                turn,
                listed,
                approval[1]!.toLowerCase() as 'approve' | 'reject',
                Number(approval[2]),
                approval[3]!.toUpperCase(),
            );
        } else {
            text = message ? await this.reason(turn, history, message) : HELP;
        }
        await ctx.memory.appendTurn(req.sessionId, {
            role: 'agent',
            text,
            at: ctx.now().toISOString(),
        });
        return {
            text,
            cards: turn.cards,
            decisionIds: turn.decisionIds,
            toolCalls: turn.toolCalls,
        };
    }

    private async reason(
        turn: Turn,
        history: Awaited<ReturnType<Ctx['memory']['turns']>>,
        text: string,
    ): Promise<string> {
        const { ctx } = this;
        const run = (name: string, args: Record<string, unknown>) =>
            invoke(ctx, TOOLS, turn, name, args);
        if (ctx.reasoner) {
            try {
                const zones = (await ctx.api.zones()).map((z) => z.name).join(', ');
                const out = await ctx.reasoner.converse({
                    system: SYSTEM(turn.operator, zones),
                    history,
                    text,
                    tools: specs(TOOLS, turn.operator),
                    run,
                });
                if (out.text) return out.text;
            } catch (err) {
                ctx.log.warn(
                    { err: describeError(err) },
                    'reasoner failed; using the rules router',
                );
            }
        }
        const calls = route(text);
        if (!calls.length) return HELP;
        const summaries: string[] = [];
        for (const call of calls) {
            summaries.push((await run(call.name, call.args)).summary);
        }
        return summaries.join('\n\n');
    }

    private async decideApproval(
        turn: Turn,
        listed: boolean,
        decision: 'approve' | 'reject',
        number: number,
        code: string,
    ): Promise<string> {
        const { ctx } = this;
        if (!turn.operator) return 'Only an Ember operator can decide approvals.';
        // Open demo mode lets anyone approve only while alerts cannot reach a real phone.
        if (!listed && ctx.transport.name !== 'log') {
            return 'Alerts here reach real phones, so only an allow-listed Ember operator can approve them.';
        }
        if (!this.deps.relay.enabled) {
            return 'Approvals from ASI:One are not enabled on this deployment; approve in the Ember dashboard.';
        }
        const approval = (await ctx.api.approvals()).find((a) => a.number === number);
        if (!approval) return `There is no approval ${number}.`;
        try {
            const decided = await this.deps.relay.decide(approval.id, {
                decision,
                operator: turn.actor,
                confirmationCode: code,
            });
            const d = await decide(ctx, {
                zoneId: decided.zoneId,
                incidentId: decided.incidentId,
                domain: decided.draft.kind === 'civilian_alert' ? 'civilian' : 'emergency',
                kind: 'operator_decision',
                summary: `Operator ${turn.actor} ${decision}d approval ${number}`,
                reason: 'explicit operator instruction with the confirmation code',
                inputs: [{ kind: 'approval', id: approval.id, note: approval.reason }],
                confidence: 1,
                actions: [`POST /v1/approvals/${approval.id}/decision (${decision})`],
            });
            turn.decisionIds.push(d.id);
            turn.toolCalls.push({ name: 'approval_decision', ok: true });
            turn.cards.push(
                card('approval', `Approval ${number} ${decided.state}`, decided.reason, {
                    approvalId: decided.id,
                    state: decided.state,
                }),
            );
            return decision === 'approve'
                ? `Approval ${number} approved. ${decided.draft.kind === 'civilian_alert' ? `Sending to ${decided.draft.recipients.length} civilian(s) now.` : `Ember does not contact ${decided.draft.organization} itself: please reach them directly.`}`
                : `Approval ${number} rejected; nothing will be sent.`;
        } catch (err) {
            turn.toolCalls.push({ name: 'approval_decision', ok: false });
            return `Approval ${number} was not recorded: ${describeError(err)}`;
        }
    }
}
