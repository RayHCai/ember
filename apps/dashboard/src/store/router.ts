import { create } from 'zustand';

// Hash routes, so the same build works from the Tauri bundle and a dev server.

export type SetupStep = 'boundary' | 'servers' | 'drones';

export type Route =
    | { name: 'zones' }
    | { name: 'new' }
    | { name: 'setup'; zoneId: string; step: SetupStep }
    | { name: 'zone'; zoneId: string };

const STEPS = new Set<string>(['boundary', 'servers', 'drones']);

export function parseRoute(hash: string): Route {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'zones' || parts.length === 1) return { name: 'zones' };
    if (parts[1] === 'new') return { name: 'new' };
    const zoneId = parts[1]!;
    if (parts[2] === 'setup') {
        const step = STEPS.has(parts[3] ?? '') ? (parts[3] as SetupStep) : 'boundary';
        return { name: 'setup', zoneId, step };
    }
    return { name: 'zone', zoneId };
}

export function routePath(route: Route): string {
    switch (route.name) {
        case 'zones':
            return '#/zones';
        case 'new':
            return '#/zones/new';
        case 'setup':
            return `#/zones/${encodeURIComponent(route.zoneId)}/setup/${route.step}`;
        case 'zone':
            return `#/zones/${encodeURIComponent(route.zoneId)}`;
    }
}

interface RouterState {
    route: Route;
    /** The route before this one, so transitions can tell direction. */
    previous: Route | null;
}

export const useRouter = create<RouterState>()(() => ({
    route: parseRoute(window.location.hash),
    previous: null,
}));

window.addEventListener('hashchange', () => {
    useRouter.setState((s) => ({ route: parseRoute(window.location.hash), previous: s.route }));
});

export function navigate(route: Route, replace = false): void {
    const path = routePath(route);
    if (window.location.hash === path) return;
    if (replace) {
        window.history.replaceState(null, '', path);
        useRouter.setState((s) => ({ route, previous: s.route }));
    } else {
        window.location.hash = path;
    }
}

/** A key that changes only when a different page (not just a different step) shows. */
export function pageKey(route: Route): string {
    switch (route.name) {
        case 'zones':
            return 'zones';
        case 'new':
        case 'setup':
            return 'setup';
        case 'zone':
            return `zone:${route.zoneId}`;
    }
}
