import type { ResponderMessage } from '@ember/contracts';
import { sorted } from "./sorted";

/** Union by id, newest first, capped so the on-disk feed stays small. */
export function mergeMessages(
    current: ResponderMessage[],
    incoming: ResponderMessage[],
    cap = 200,
): ResponderMessage[] {
    const byId = new Map<string, ResponderMessage>();
    for (const m of current) byId.set(m.id, m);
    for (const m of incoming) byId.set(m.id, m);
    return sorted([...byId.values()], (a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt)).slice(
        0,
        cap,
    );
}

export function unreadCount(messages: ResponderMessage[], lastReadAt: string | null): number {
    if (!lastReadAt) return messages.length;
    const t = Date.parse(lastReadAt);
    return messages.filter((m) => Date.parse(m.sentAt) > t).length;
}
