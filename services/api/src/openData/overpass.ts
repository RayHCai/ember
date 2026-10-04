import { parseElements } from './osm.js';
import type { OsmElement } from './osm.js';
import { OpenDataError } from './types.js';

export type Overpass = (query: string) => Promise<OsmElement[]>;

export type OverpassOptions = {
    fetch: typeof fetch;
    url: string;
    timeoutMs: number;
    userAgent: string;
};

const isTimeout = (error: unknown) =>
    error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

/** Runs an Overpass QL body (statements after the settings line) and returns its elements. */
export function createOverpass(options: OverpassOptions): Overpass {
    const seconds = Math.max(1, Math.round(options.timeoutMs / 1000));

    return async (query) => {
        const body = new URLSearchParams({
            data: `[out:json][timeout:${seconds}];\n${query}`,
        }).toString();

        let json: unknown;
        try {
            const response = await options.fetch(options.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'application/json',
                    'user-agent': options.userAgent,
                },
                body,
                signal: AbortSignal.timeout(options.timeoutMs),
            });
            if (!response.ok) throw new OpenDataError(`overpass: HTTP ${response.status}`);
            json = await response.json();
        } catch (error) {
            if (error instanceof OpenDataError) throw error;
            if (isTimeout(error)) {
                throw new OpenDataError(`overpass: no answer within ${seconds}s`, { cause: error });
            }
            const reason = error instanceof SyntaxError ? 'response is not JSON' : 'request failed';
            throw new OpenDataError(`overpass: ${reason}`, { cause: error });
        }

        if (typeof json !== 'object' || json === null || !('elements' in json)) {
            throw new OpenDataError('overpass: unexpected response');
        }
        // A 200 with a runtime remark means the server gave up part way and the data is partial.
        if (
            'remark' in json &&
            typeof json.remark === 'string' &&
            /runtime error/i.test(json.remark)
        ) {
            throw new OpenDataError(`overpass: ${json.remark.slice(0, 120)}`);
        }
        if (!Array.isArray(json.elements)) throw new OpenDataError('overpass: unexpected response');
        return parseElements(json.elements);
    };
}
