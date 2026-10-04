/**
 * Numbers a drafted text may contain: those in the facts it was drafted from. A draft that
 * states any other number (a time, a distance, a count) is rejected and the template is used.
 */
export function numbersIn(text: string): number[] {
    return [...text.matchAll(/-?\d+(?:[.,]\d+)*/g)].map((m) => Number(m[0].replace(/,/g, '')));
}

function collect(value: unknown, out: Set<number>) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        out.add(value);
        out.add(Math.round(value));
        out.add(Math.round(value * 10) / 10);
        out.add(Math.abs(value));
    } else if (typeof value === 'string') {
        for (const n of numbersIn(value)) out.add(n);
    } else if (Array.isArray(value)) {
        for (const v of value) collect(v, out);
    } else if (value && typeof value === 'object') {
        for (const v of Object.values(value)) collect(v, out);
    }
}

/** Small counts ("1 route", "2 roads") read as words, not data. */
const FREE = new Set([0, 1, 2]);

export function unsupportedNumbers(text: string, facts: unknown): number[] {
    const allowed = new Set<number>();
    collect(facts, allowed);
    return numbersIn(text).filter((n) => !FREE.has(n) && !allowed.has(n));
}
