import type { WatchZoneId } from './common.js';
import type { OperationalDomain } from './incident.js';

/**
 * operator-agent's own surface. The uAgent bridge (operator-uagent) forwards each ASI:One
 * `ChatMessage` to `POST ${AGENT_CHAT_PATH}` and relays the reply; the dashboard calls the same
 * path. Decisions are operator-agent's log, read at `GET ${AGENT_DECISIONS_PATH}`.
 */
export const AGENT_CHAT_PATH = '/v1/chat';
export const AGENT_DECISIONS_PATH = '/v1/decisions';
export const AGENT_DECISION_PATH = '/v1/decisions/:decisionId';

export type AgentChannel = 'asi1' | 'dashboard';

export type AgentChatRequest = {
    channel: AgentChannel;
    /** The ASI:One sender address, or the dashboard operator's name. */
    sender: string;
    /** One conversation; ASI:One's session id. */
    sessionId: string;
    text: string;
    sentAt: string;
};

export type AgentCardKind =
    | 'risk_ranking'
    | 'incident'
    | 'approval'
    | 'responder_plan'
    | 'civilian_plan'
    | 'plan_diff'
    | 'decision'
    | 'scan';

/** A structured block the channel renders as it can; `markdown` is the plain fallback. */
export type AgentCard = {
    kind: AgentCardKind;
    title: string;
    markdown: string;
    /** Replies the user can send back verbatim, e.g. `approve 7 K3QF`. */
    actions: { label: string; reply: string }[];
    data: unknown;
};

export type AgentChatReply = {
    text: string;
    cards: AgentCard[];
    /** Decisions this turn logged. */
    decisionIds: string[];
    /** Every api call the turn made, in order. */
    toolCalls: { name: string; ok: boolean }[];
};

export type DecisionInputKind =
    | 'planner_job'
    | 'detection'
    | 'road_observation'
    | 'weather'
    | 'scan'
    | 'approval'
    | 'report'
    | 'message'
    | 'incident'
    | 'chat';

/** One significant thing the agent decided, with what it saw and how sure it was. */
export type Decision = {
    id: string;
    /** Sequential: "decision 31". */
    number: number;
    at: string;
    zoneId: WatchZoneId | null;
    incidentId: string | null;
    domain: OperationalDomain;
    /** e.g. `scan_cadence`, `verify_detection`, `escalate`, `replan`, `notify`. */
    kind: string;
    summary: string;
    reason: string;
    inputs: { kind: DecisionInputKind; id: string; note: string }[];
    /** 0 to 1. */
    confidence: number;
    /** What was done, e.g. `POST /v1/watch-zones/z1/scans -> run r-4`. */
    actions: string[];
};
