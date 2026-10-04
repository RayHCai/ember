import { create } from 'zustand';

// Hash routes, so the same build works from the Tauri bundle and a dev server.

export type Route =
    | { name: 'zones' }
    | { name: 'new' }
    | { name: 'edit'; zoneId: string }
    | { name: 'zone'; zoneId: string };

export function parseRoute(hash: string): Route {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'zones' || parts.length === 1) return { name: 'zones' };
    if (parts[1] === 'new') return { name: 'new' };
    const zoneId = parts[1]!;
    if (parts[2] === 'edit') return { name: 'edit', zoneId };
    return { name: 'zone', zoneId };
}

export function routePath(route: Route): string {
    switch (route.name) {
        case 'zones':
            return '#/zones';
        case 'new':
            return '#/zones/new';
        case 'edit':
            return `#/zones/${encodeURIComponent(route.zoneId)}/edit`;
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

/** A key that changes only when a different page shows. */
export function pageKey(route: Route): string {
    switch (route.name) {
        case 'zones':
            return 'zones';
        case 'new':
        case 'edit':
            return 'draw';
        case 'zone':
            return `zone:${route.zoneId}`;
    }
}
