/**
 * The rules router: maps the demo's requests to tool calls when Gemini is not configured or
 * fails. It only picks tools; every fact in the answer still comes from them.
 */

export type Call = { name: string; args: Record<string, unknown> };

export const HELP =
    'I can analyze wildfire risk, start or stop drone surveillance, simulate a fire, coordinate a response, ' +
    'list civilians who need to evacuate, explain routes and decisions, and take road reports such as ' +
    '"Responder 2 says Ridge Road is blocked". Start with "Analyze wildfire risk around Lahaina." ' +
    'Say "Reset the demo" to start over.';

type Rule = { test: RegExp; calls: (m: RegExpExecArray) => Call[] };

const sector = (text: string) => {
    const m = /\b(?:sector\s*|s)(\d{1,3})\b/i.exec(text);
    return m ? `S${m[1]}` : undefined;
};

const RULES: Rule[] = [
    {
        test: /^\s*(?:responder|civilian)\s*#?\d+\s+(?:says|reports?|reported)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is|was|has been)\s+(blocked|closed|impassable|open|clear|reopened)/i,
        calls: (m) => {
            const reporter = /^\s*((?:responder|civilian)\s*#?\d+)/i.exec(m.input)![1]!;
            return [
                {
                    name: 'update_road_state',
                    args: {
                        roadName: m[1]!,
                        state: /open|clear/i.test(m[2]!) ? 'open' : 'blocked',
                        reporter,
                        note: m.input.trim(),
                    },
                },
            ];
        },
    },
    {
        test: /\breset\b|start\s+over|clear\s+the\s+demo/i,
        calls: () => [{ name: 'reset_demo', args: {} }],
    },
    { test: /what\s+changed/i, calls: () => [{ name: 'what_changed', args: {} }] },
    {
        test: /what\s+happened|why\s+did\s+(?:you|ember)/i,
        calls: () => [{ name: 'what_happened', args: {} }],
    },
    {
        test: /why\s+.*civilian\s*#?(\d+)|civilian\s*#?(\d+).*\brout/i,
        calls: (m) => [{ name: 'explain_route', args: { civilianNumber: Number(m[1] ?? m[2]) } }],
    },
    {
        test: /explain\s+decision\s*#?(\d+)/i,
        calls: (m) => [{ name: 'explain_decision', args: { decision: m[1]! } }],
    },
    {
        test: /which\s+civilians|need(?:s)?\s+(?:to\s+)?evacuat|evacuation\s+list/i,
        calls: () => [{ name: 'list_civilians_to_evacuate', args: {} }],
    },
    {
        test: /coordinate|respond\s+to|dispatch/i,
        calls: () => [{ name: 'coordinate_response', args: {} }],
    },
    {
        test: /simulat\w*\s+(?:a\s+)?fire/i,
        calls: (m) => [
            { name: 'simulate_fire', args: sector(m.input) ? { sector: sector(m.input) } : {} },
        ],
    },
    {
        test: /(?:begin|start|increase)\s+(?:the\s+)?(?:drone\s+)?(?:surveillance|scan|monitoring)/i,
        calls: (m) => [
            { name: 'start_scan', args: sector(m.input) ? { sectorIds: [sector(m.input)] } : {} },
        ],
    },
    {
        test: /stop\s+(?:the\s+)?(?:scan|surveillance)/i,
        calls: () => [{ name: 'stop_scan', args: {} }],
    },
    {
        test: /creat\w*\s+(?:a\s+)?watch\s*zone(?:\s+(?:around|at|for|near)\s+(.+?))?[.!?]?$/i,
        calls: (m) => [
            {
                name: 'create_watch_zone',
                args: m[1] ? { name: m[1], place: m[1] } : { name: 'New watch zone' },
            },
        ],
    },
    {
        test: /analy[sz]e.*risk|risk\s+(?:around|near|in|for)/i,
        calls: () => [{ name: 'rank_regions', args: { refresh: true } }],
    },
    {
        test: /(?:greatest|highest|most|top)\b.*risk|risk.*(?:rank|highest)/i,
        calls: () => [{ name: 'rank_regions', args: {} }],
    },
    { test: /weather|wind|humidity/i, calls: () => [{ name: 'get_weather', args: {} }] },
    { test: /approvals?|pending/i, calls: () => [{ name: 'list_pending_approvals', args: {} }] },
    { test: /incident|status|situation/i, calls: () => [{ name: 'get_incident_state', args: {} }] },
    {
        test: /attack\s+zones?|drop\s+sites?/i,
        calls: () => [{ name: 'get_attack_zones', args: {} }],
    },
    { test: /detections?/i, calls: () => [{ name: 'get_detections', args: {} }] },
    { test: /watch\s+zones?|zones/i, calls: () => [{ name: 'get_watch_zones', args: {} }] },
];

export function route(text: string): Call[] {
    for (const rule of RULES) {
        const m = rule.test.exec(text);
        if (m) return rule.calls(m);
    }
    return [];
}
