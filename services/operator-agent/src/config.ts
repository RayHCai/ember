export type AgentConfig = {
    apiUrl: string;
    /** Where civilian texts link for the read-only evacuation map; null leaves the link out. */
    civilianMapUrl: string | null;
    /** Where unknown civilians are sent to sign up. */
    signupUrl: string | null;
    /** ASI:One addresses whose `approve <n> <code>` counts as an operator decision. */
    operatorAddresses: string[];
    tickMs: number;
    plannerWaitMs: number;
    /** Detections at or above this confidence count as confirmed without verification. */
    confirmConfidence: number;
    /** Below this, a detection is logged and watched, not verified. */
    verifyConfidence: number;
    /** A second detection this close to a first corroborates it. */
    corroborateM: number;
    /** A risk plan older than this is refreshed. */
    riskPlanMaxAgeMin: number;
};

export function configFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
    const num = (name: string, fallback: number) => {
        const v = Number(env[name] ?? fallback);
        if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got ${env[name]}`);
        return v;
    };
    return {
        apiUrl: env.EMBER_API_URL ?? 'http://localhost:4001',
        civilianMapUrl: env.EMBER_CIVILIAN_MAP_URL ?? null,
        signupUrl: env.EMBER_SIGNUP_URL ?? null,
        operatorAddresses: (env.EMBER_OPERATOR_ASI1_ADDRESSES ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        tickMs: num('EMBER_AGENT_TICK_MS', 10_000),
        plannerWaitMs: num('EMBER_PLANNER_WAIT_MS', 90_000),
        confirmConfidence: num('EMBER_CONFIRM_CONFIDENCE', 0.85),
        verifyConfidence: num('EMBER_VERIFY_CONFIDENCE', 0.35),
        corroborateM: num('EMBER_CORROBORATE_M', 500),
        riskPlanMaxAgeMin: num('EMBER_RISK_PLAN_MAX_AGE_MIN', 30),
    };
}
