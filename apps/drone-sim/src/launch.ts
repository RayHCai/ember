export const DEFAULT_DEMO_DATA_URL = 'http://localhost:8090';

/**
 * Which drone this instance shows and where its data comes from. Fixed for the life of the
 * process: showing a different drone means restarting the sim.
 */
export type Launch = {
    droneId: string | null;
    /** Empty: the dummy feed stands in for Drone Info. */
    droneInfoUrl: string;
    demoDataUrl: string;
};

/** What the Tauri shell injects as `window.emberSimLaunch` (from scripts/start.mjs, via env vars). */
export type InjectedLaunch = {
    drone?: string | null;
    droneInfoUrl?: string | null;
    demoDataUrl?: string | null;
};

const pick = (a: string | null | undefined, b: string | null): string => (a ?? b ?? '').trim();

/** Launch settings from the Tauri shell, or in a browser from `?drone=&droneInfo=&demoData=`. */
export function readLaunch(injected: InjectedLaunch | undefined, search: string): Launch {
    const q = new URLSearchParams(search);
    const demoData = pick(injected?.demoDataUrl, q.get('demoData')) || DEFAULT_DEMO_DATA_URL;
    return {
        droneId: pick(injected?.drone, q.get('drone')) || null,
        droneInfoUrl: pick(injected?.droneInfoUrl, q.get('droneInfo')),
        demoDataUrl: demoData.replace(/\/+$/, ''),
    };
}
