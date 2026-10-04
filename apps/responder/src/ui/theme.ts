import { StyleSheet } from 'react-native';
import type { FuelType } from '@ember/contracts';

/** Light only: responders work outdoors in daylight, and one palette keeps fire colours fixed. */
export const C = {
    bg: '#FFFFFF',
    tint: '#FDF4F2',
    border: '#F0E2DE',
    text: '#1C1412',
    muted: '#76665F',
    faint: '#B3A49F',

    primary: '#D92D20',
    primaryDark: '#B42318',
    onPrimary: '#FFFFFF',

    fire: '#D92D20',
    spread: '#F97316',
    risk: '#F59E0B',
    site: '#1C1412',
    safe: '#16A34A',

    shadow: 'rgba(60,20,10,0.16)',

    map: {
        sea: '#EDF1F3',
        land: '#FAF8F4',
        boundary: '#1C1412',
        road: '#FFFFFF',
        roadCasing: '#DDD5CF',
        label: '#76665F',
        fuel: {
            none: '#F2EFEA',
            grass: '#F3F2E4',
            shrub: '#E9ECD8',
            timber: '#DEE6CE',
            urban: '#EFEBE7',
        } satisfies Record<FuelType, string>,
    },
};

export const font = StyleSheet.create({
    title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4, color: C.text },
    heading: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2, color: C.text },
    body: { fontSize: 15, lineHeight: 20, color: C.muted },
    label: { fontSize: 13, fontWeight: '600', color: C.text },
    small: { fontSize: 12, fontWeight: '500', color: C.muted },
    num: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'], color: C.text },
});
