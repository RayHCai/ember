export function ago(at: number | null, now = Date.now()): string {
    if (at === null) return 'never';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m ` : ''}ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function until(at: number | null, now = Date.now()): string {
    if (at === null) return 'not scheduled';
    const m = Math.max(0, Math.round((at - now) / 60_000));
    if (m < 1) return 'any moment';
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60);
    return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

export function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function minutes(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m} min`;
}
