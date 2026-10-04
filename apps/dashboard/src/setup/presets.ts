import type { LatLon } from '../sim/types';

export interface Preset {
    name: string;
    region: string;
    at: LatLon;
    heightM: number;
}

// Forested, fire-prone places to start a watch zone from.
export const PRESETS: Preset[] = [
    {
        name: 'Angeles NF',
        region: 'Angeles National Forest, CA',
        at: [34.235, -118.06],
        heightM: 26_000,
    },
    {
        name: 'Santa Cruz Mtns',
        region: 'Santa Cruz County, CA',
        at: [37.17, -122.15],
        heightM: 26_000,
    },
    {
        name: 'Boulder foothills',
        region: 'Boulder County, CO',
        at: [40.0, -105.32],
        heightM: 22_000,
    },
    {
        name: 'Huron-Manistee',
        region: 'Huron-Manistee National Forests, MI',
        at: [44.43, -85.88],
        heightM: 26_000,
    },
    {
        name: 'Sequoia NP',
        region: 'Sequoia National Park, CA',
        at: [36.565, -118.77],
        heightM: 26_000,
    },
];
