import { expect, test } from 'vitest';
import { MemoryCollection, MemoryCounters } from './collection.js';

type Doc = { id: string; zoneId: string; n: number; state: string | null };

test('memory collections filter, order and copy', async () => {
    const c = new MemoryCollection<Doc>('id');
    expect(await c.insert({ id: 'a', zoneId: 'z', n: 2, state: null })).toBe(true);
    expect(await c.insert({ id: 'a', zoneId: 'z', n: 9, state: null })).toBe(false);
    await c.put({ id: 'b', zoneId: 'z', n: 10, state: 'x' });
    await c.put({ id: 'c', zoneId: 'y', n: 1, state: 'x' });
    expect((await c.list({ zoneId: 'z' }, { orderBy: 'n', desc: true })).map((d) => d.id)).toEqual([
        'b',
        'a',
    ]);
    expect((await c.list({ state: null })).map((d) => d.id)).toEqual(['a']);
    expect((await c.list({}, { orderBy: 'n', limit: 1 })).map((d) => d.id)).toEqual(['c']);
    const got = (await c.get('a'))!;
    got.n = 100;
    expect((await c.get('a'))!.n).toBe(2);
    const counters = new MemoryCounters();
    expect([await counters.next('x'), await counters.next('x'), await counters.next('y')]).toEqual([
        1, 2, 1,
    ]);
});
