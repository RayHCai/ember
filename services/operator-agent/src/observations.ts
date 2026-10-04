import { z } from 'zod';
import { describeError, type Ctx } from './context.js';

/** One free-text message from the field, structured. */
export const observationSchema = z.object({
    kind: z.enum([
        'road',
        'responder_status',
        'fire_sighting',
        'question',
        'check_in',
        'household',
        'other',
    ]),
    roadName: z
        .string()
        .nullable()
        .describe('The road as written, when kind is road or the question names one'),
    roadState: z.enum(['blocked', 'open', 'uncertain']).nullable(),
    responderStatus: z.enum(['en_route', 'on_scene', 'returning', 'unavailable']).nullable(),
    householdNote: z
        .string()
        .nullable()
        .describe('Pets, mobility needs, people at home, if mentioned'),
    question: z.enum(['evacuate', 'route', 'road', 'risk', 'other']).nullable(),
});

export type Observation = z.infer<typeof observationSchema>;

const EMPTY: Observation = {
    kind: 'other',
    roadName: null,
    roadState: null,
    responderStatus: null,
    householdNote: null,
    question: null,
};

const ROAD_WORDS = [
    'road',
    'rd',
    'street',
    'st',
    'highway',
    'hwy',
    'route',
    'avenue',
    'ave',
    'drive',
    'dr',
    'lane',
    'ln',
    'bypass',
    'way',
];
// Capitalised words then a road word in either case: "Ridge Road", "Kuialua st", not "the road".
const NAMED_ROAD = new RegExp(
    `((?:[A-Z][\\w'ʻ-]*\\s+){1,3}(?:${ROAD_WORDS.map((w) => `[${w[0]}${w[0]!.toUpperCase()}]${w.slice(1)}`).join('|')}))\\b`,
);

/** The fallback parser: the patterns the demo and common field reports use. */
export function parseByRules(text: string): Observation {
    const t = text.trim();
    const asked = /\bcan i (?:take|use|drive(?: on)?)\s+(?:the\s+)?(.+?)\s*\??\s*$/i.exec(t);
    if (asked) return { ...EMPTY, kind: 'question', question: 'road', roadName: asked[1]! };
    const numbered = /\b((?:highway|hwy|route)\s+\d+)\b/i.exec(t)?.[1];
    const named = numbered ?? NAMED_ROAD.exec(t)?.[1]?.trim() ?? null;
    const state = /\b(blocked|closed|impassable|jammed|gridlock)/i.test(t)
        ? 'blocked'
        : /\b(reopened|open again|clear(?:ed)? now|is open|is clear)/i.test(t)
          ? 'open'
          : null;
    if (state && !/^\s*(can|should|is)\b.*\?\s*$/i.test(t)) {
        return {
            ...EMPTY,
            kind: 'road',
            roadName: named && !/^road$/i.test(named) ? named : null,
            roadState: state,
        };
    }
    if (/\b(reached|arrived|on scene|at the drop site|on site)\b/i.test(t))
        return { ...EMPTY, kind: 'responder_status', responderStatus: 'on_scene' };
    if (/\b(en route|on (?:our|my) way|heading (?:to|out))\b/i.test(t))
        return { ...EMPTY, kind: 'responder_status', responderStatus: 'en_route' };
    if (/\b(i'?m safe|we'?re safe|safe now|evacuated|made it)\b/i.test(t))
        return { ...EMPTY, kind: 'check_in' };
    if (/\b(smoke|flames?|fire)\b/i.test(t) && !/\?\s*$/.test(t))
        return { ...EMPTY, kind: 'fire_sighting' };
    if (/\b(evacuat|leave|should i go|need to go)\w*/i.test(t))
        return { ...EMPTY, kind: 'question', question: 'evacuate' };
    if (/\b(which|what) (?:road|route|way)\b/i.test(t))
        return { ...EMPTY, kind: 'question', question: 'route' };
    if (/\brisk|danger|safe\?/i.test(t)) return { ...EMPTY, kind: 'question', question: 'risk' };
    const household =
        /\b(dogs?|cats?|pets?|wheelchair|oxygen|baby|kids|children|elderly|horses?)\b/i.exec(t);
    if (household) return { ...EMPTY, kind: 'household', householdNote: t.slice(0, 200) };
    return /\?\s*$/.test(t) ? { ...EMPTY, kind: 'question', question: 'other' } : EMPTY;
}

export async function parseObservation(ctx: Ctx, text: string, from: string): Promise<Observation> {
    if (ctx.reasoner) {
        try {
            return await ctx.reasoner.structured({
                system:
                    'Extract one structured observation from a short message sent to Ember, a wildfire response system. ' +
                    'Copy road names exactly as written; never invent a road. Use null for anything not stated.',
                prompt: `From ${from}: "${text}"`,
                schema: observationSchema,
            });
        } catch (err) {
            ctx.log.warn({ err: describeError(err) }, 'observation parsing fell back to rules');
        }
    }
    return parseByRules(text);
}
