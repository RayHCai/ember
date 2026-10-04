/**
 * operator-agent's own surface. The uAgent bridge (operator-uagent) forwards each ASI:One
 * `ChatMessage` to `POST ${AGENT_CHAT_PATH}` and relays the reply. Callers send
 * `Authorization: Bearer <EMBER_AGENT_KEY>`.
 */
export const AGENT_CHAT_PATH = '/v1/chat';

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

export type AgentCardKind = 'incident' | 'responder_plan' | 'evacuation';

/** A structured block the channel renders as it can; `markdown` is the plain fallback. */
export type AgentCard = {
    kind: AgentCardKind;
    title: string;
    markdown: string;
    data: unknown;
};

export type AgentChatReply = { text: string; cards: AgentCard[] };
