import type { AgentCard, AgentCardKind } from '@ember/contracts';

export function card(
    kind: AgentCardKind,
    title: string,
    markdown: string,
    data: unknown,
    actions: AgentCard['actions'] = [],
): AgentCard {
    return { kind, title, markdown, data, actions };
}

const cell = (v: string | number | null | undefined) =>
    v === null || v === undefined ? '—' : String(v).replace(/\|/g, '/').replace(/\n/g, ' ');

export function table(headers: string[], rows: (string | number | null | undefined)[][]): string {
    return [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    ].join('\n');
}

export const minutes = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `${Math.round(v)} min`;

/** Shown wherever the planner's forecast reaches a person. */
export const SCREENING_NOTE =
    "Ember's forecast is a fast screening model, not an official evacuation order or a calibrated fire simulation.";
