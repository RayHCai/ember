import { expect, test } from 'vitest';
import {
    DISCLAIMER,
    evacuationBlast,
    evacuationsByZip,
    isResponderBrief,
    responderBlast,
    zipOfBlast,
} from './alerts.js';
import { compass, roadNamesAlong } from './geo.js';
import { result, surroundings, zone } from './testing/fake.js';

const zips = new Map<string, string | null>([
    ['a-kahana', '96761'],
    ['a-napili', '96761'],
    ['a-front', '96767'],
    ['a-far', '96761'],
]);

test('groups the areas told to leave by zip, soonest fire first', () => {
    const { byZip, unplaced } = evacuationsByZip(result, zips);
    expect(byZip.map((z) => [z.zipCode, z.areas.map((a) => a.impact.name)])).toEqual([
        ['96761', ['Kahana', 'Napili']],
        ['96767', ['Front Street']],
    ]);
    expect(unplaced).toEqual([]);
});

test('an area with no known zip is reported, not guessed', () => {
    const { byZip, unplaced } = evacuationsByZip(result, new Map([['a-kahana', '96761']]));
    expect(byZip.map((z) => z.zipCode)).toEqual(['96761']);
    expect(unplaced.map((i) => i.name)).toEqual(['Napili', 'Front Street']);
});

test('an evacuation text names the route, destination, map and disclaimer', () => {
    const [kahana, front] = evacuationsByZip(result, zips).byZip;
    const blast = evacuationBlast(zone, kahana!, surroundings, 'https://map.ember.test');
    expect(blast).toMatchObject({ audience: 'civilians', priority: 'critical', area: 'near_fire' });
    expect(zipOfBlast(blast.title)).toBe('96761');
    expect(blast.body).toContain('Fire is forecast to reach Kahana in about 25 min. Evacuate now.');
    expect(blast.body).toContain(
        'Kahana: take Honoapiilani Hwy to Kapalua Airport (about 12 min).',
    );
    expect(blast.body).toContain('Napili: no safe road out was found');
    expect(blast.body).toContain('Map: https://map.ember.test?zone=zone-1');
    expect(blast.body.endsWith(DISCLAIMER)).toBe(true);

    const other = evacuationBlast(zone, front!, surroundings, null);
    expect(other.priority).toBe('urgent');
    expect(other.body).toContain(
        'Front Street: no safe road out was found. If you cannot leave safely, call 911.',
    );
    expect(other.body).not.toContain('Map:');
});

test('a long evacuation text drops extra areas but keeps the lead route and disclaimer', () => {
    const [kahana] = evacuationsByZip(result, zips).byZip;
    const many = {
        ...kahana!,
        areas: [
            ...kahana!.areas,
            ...Array.from({ length: 40 }, (_, i) => ({
                ...kahana!.areas[1]!,
                impact: { ...kahana!.areas[1]!.impact, name: `Area ${i}` },
            })),
        ],
    };
    const blast = evacuationBlast(zone, many, surroundings, 'https://map.ember.test');
    expect(blast.body.length).toBeLessThanOrEqual(1000);
    expect(blast.title.length).toBeLessThanOrEqual(120);
    expect(zipOfBlast(blast.title)).toBe('96761');
    expect(blast.body).toContain('Kahana: take Honoapiilani Hwy');
    expect(blast.body.endsWith(DISCLAIMER)).toBe(true);
});

test('the responder brief lists the best attack zones by rank', () => {
    const blast = responderBlast(zone, result, 2);
    expect(blast).toMatchObject({ audience: 'responders', title: 'Responder staging: Lahaina' });
    expect(isResponderBrief(blast.title)).toBe(true);
    expect(zipOfBlast(blast.title)).toBeNull();
    expect(blast.body.split('\n')).toEqual([
        'Fire heading north, spreading up to 12.3 m/min.',
        '#1 indirect attack: stage at 20.91000, -156.66000, about 12 min from the nearest station; work a 400 m radius. Fire arrives in about 30 min. Protects Kahana (1,200 people).',
        '#2 direct attack: stage at 20.92000, -156.66000, about 12 min from the nearest station; work a 400 m radius. Fire arrives in about 60 min. Protects Kahana (1,200 people).',
    ]);
});

test('roads along a route, in order, once each', () => {
    const route = result.evacuationRoutes[0]!.path;
    expect(roadNamesAlong(route, surroundings.roads)).toEqual(['Honoapiilani Hwy']);
    expect(roadNamesAlong(route, [])).toEqual([]);
    expect([0, 44, 90, 225, 350].map(compass)).toEqual([
        'north',
        'northeast',
        'east',
        'southwest',
        'north',
    ]);
});
