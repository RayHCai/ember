import { expect, test } from 'vitest';
import { parseByRules } from './observations.js';

test.each([
    ['Ridge Road is blocked', { kind: 'road', roadName: 'Ridge Road', roadState: 'blocked' }],
    ['Road blocked.', { kind: 'road', roadName: null, roadState: 'blocked' }],
    [
        'highway 30 is closed near the bypass',
        { kind: 'road', roadName: 'highway 30', roadState: 'blocked' },
    ],
    ['Kuialua st reopened', { kind: 'road', roadName: 'Kuialua st', roadState: 'open' }],
    ['Can I take Highway 30?', { kind: 'question', question: 'road', roadName: 'Highway 30' }],
    ['Do I need to evacuate?', { kind: 'question', question: 'evacuate' }],
    ["I've reached the drop site.", { kind: 'responder_status', responderStatus: 'on_scene' }],
    ['We made it to the civic center', { kind: 'check_in' }],
    ['Smoke behind the school', { kind: 'fire_sighting' }],
    ['We have two cats and my mom uses a walker', { kind: 'household' }],
])('%s', (text, expected) => {
    expect(parseByRules(text)).toMatchObject(expected);
});
