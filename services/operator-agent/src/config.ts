export type AgentConfig = {
    apiUrl: string;
    /** Bearer for the api; also the only key that reads civilians' phone numbers there. */
    apiKey: string | undefined;
    /** Bearer `/v1/chat` requires (operator-uagent sends it); unset accepts anything (development). */
    chatKey: string | undefined;
    /** Where evacuation texts link for the read-only map; null leaves the link out. */
    civilianMapUrl: string | null;
    tickMs: number;
    /** A failed plan for an open incident is requested again after this long. */
    planRetryMs: number;
    /** On start, approved alerts older than this are taken as already delivered. */
    deliveryLookbackMin: number;
    /** Attack zones named in a responder brief, best first. */
    responderZones: number;
    /** The operator's phone, texted each evacuation plan without approval; null for none. */
    notifyPhone: string | null;
    /** How often the notify phone's plan check runs, apart from the incident loop. */
    notifyTickMs: number;
    /** IANA zone the alert times are written in, where the people texted are. */
    timeZone: string;
};

function phone(v: string | undefined): string | null {
    if (!v) return null;
    if (!/^\+[1-9][0-9]{7,14}$/.test(v)) {
        throw new Error(`EMBER_NOTIFY_PHONE must be E.164 (e.g. +15551234567), got ${v}`);
    }
    return v;
}

function timeZone(v: string | undefined): string {
    const tz = v || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    } catch {
        throw new Error(
            `EMBER_TIME_ZONE must be an IANA time zone (e.g. Pacific/Honolulu), got ${v}`,
        );
    }
    return tz;
}

export function configFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
    const num = (name: string, fallback: number) => {
        const v = Number(env[name] ?? fallback);
        if (!Number.isFinite(v) || v < 0) {
            throw new Error(`${name} must be a non-negative number, got ${env[name]}`);
        }
        return v;
    };
    return {
        apiUrl: (env.EMBER_API_URL ?? 'http://localhost:4001').replace(/\/$/, ''),
        apiKey: env.EMBER_AGENT_KEY || undefined,
        chatKey: env.EMBER_AGENT_CHAT_KEY || undefined,
        civilianMapUrl: env.EMBER_CIVILIAN_MAP_URL || null,
        tickMs: num('EMBER_AGENT_TICK_MS', 10_000),
        planRetryMs: num('EMBER_PLAN_RETRY_MS', 120_000),
        deliveryLookbackMin: num('EMBER_DELIVERY_LOOKBACK_MIN', 60),
        responderZones: num('EMBER_RESPONDER_ZONES', 3),
        notifyPhone: phone(env.EMBER_NOTIFY_PHONE),
        notifyTickMs: num('EMBER_NOTIFY_TICK_MS', 2_000),
        timeZone: timeZone(env.EMBER_TIME_ZONE),
    };
}
