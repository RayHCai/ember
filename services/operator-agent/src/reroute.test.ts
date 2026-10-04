import { beforeEach, expect, test } from 'vitest';
import { LogTransport } from './channels.js';
import { Notices } from './notices.js';
import { REROUTE_BY, Reroute } from './reroute.js';
import { FakeApi, fire, T0 } from './testing/fake.js';

const PHONE = '+16025550100';
const silent = { info: () => {}, warn: () => {} };
let api: FakeApi;
let transport: LogTransport;
let asked: string[];
let reroute: Reroute;

beforeEach(() => {
    api = new FakeApi(() => new Date(T0));
    transport = new LogTransport();
    asked = [];
    reroute = new Reroute({
        api,
        transport,
        phone: PHONE,
        wantsNewRoute: async (text) => {
            asked.push(text);
            return /route/i.test(text);
        },
        log: silent,
    });
});

test('a new-route text plans the burning zone again, and its plan goes out as usual', async () => {
    const notices = new Notices({
        api,
        transport,
        phone: PHONE,
        log: silent,
        tiles: async () => null,
        timeZone: 'Pacific/Honolulu',
        now: () => new Date(T0),
    });
    api.riskZoneList = [fire()];
    await notices.watch();
    await reroute.handle('+1 (602) 555-0100', 'can I get a new route?');
    expect(api.jobs.map((j) => j.requestedBy)).toEqual([REROUTE_BY]);
    expect(transport.sent).toEqual([]);
    api.finishPlan();
    await notices.watch();
    expect(transport.sent).toHaveLength(1);
    expect(transport.images).toHaveLength(1);
});

test('texts from other numbers are not read', async () => {
    api.riskZoneList = [fire()];
    await reroute.handle('+18085550001', 'new route please');
    expect(asked).toEqual([]);
    expect(api.jobs).toEqual([]);
});

test('a text that is not a route request plans nothing and sends nothing', async () => {
    api.riskZoneList = [fire()];
    await reroute.handle(PHONE, 'thanks, got it');
    expect(asked).toEqual(['thanks, got it']);
    expect(api.jobs).toEqual([]);
    expect(transport.sent).toEqual([]);
});

test('a second ask while the new route is being planned does not plan again', async () => {
    api.riskZoneList = [fire()];
    await reroute.handle(PHONE, 'new route');
    await reroute.handle(PHONE, 'new route??');
    expect(api.jobs).toHaveLength(1);
});

test('with no fire burning it says so instead of planning', async () => {
    await reroute.handle(PHONE, 'new route');
    expect(api.jobs).toEqual([]);
    expect(transport.sent).toEqual([
        { phone: PHONE, body: 'Ember: no fire is burning now, so there is no route to plan.' },
    ]);
});
