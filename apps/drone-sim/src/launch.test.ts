import { describe, expect, it } from 'vitest';
import { DEFAULT_DEMO_DATA_URL, readLaunch } from './launch';

describe('readLaunch', () => {
    it('prefers what the Tauri shell injected over the query string', () => {
        const launch = readLaunch(
            { drone: 'pi-1', droneInfoUrl: 'ws://edge:8080', demoDataUrl: 'http://dd:8090/' },
            '?drone=dummy-2&demoData=http://other',
        );
        expect(launch).toEqual({
            droneId: 'pi-1',
            droneInfoUrl: 'ws://edge:8080',
            demoDataUrl: 'http://dd:8090',
        });
    });

    it('reads a browser query string, defaulting to the dummy feed and local Demo Data', () => {
        expect(readLaunch(undefined, '?drone=dummy-1')).toEqual({
            droneId: 'dummy-1',
            droneInfoUrl: '',
            demoDataUrl: DEFAULT_DEMO_DATA_URL,
        });
    });

    it('has no drone when none was chosen', () => {
        expect(readLaunch({ drone: null }, '?drone=%20').droneId).toBeNull();
    });
});
