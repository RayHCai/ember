import { config } from '../config';

export class ApiError extends Error {
    override name = 'ApiError';
    constructor(
        readonly status: number,
        text: string,
    ) {
        super(text);
    }
}

let token: string | null = null;
let unauthorized: (() => void) | null = null;

export function setApiToken(value: string | null): void {
    token = value;
}

/** Called when the api rejects the session, so the operator signs in again. */
export function onUnauthorized(fn: () => void): void {
    unauthorized = fn;
}

type Query = Record<string, string | number | boolean | undefined>;

interface Options {
    body?: unknown;
    query?: Query;
    signal?: AbortSignal;
    /** False for sign-in and sign-up, which carry no session. */
    auth?: boolean;
}

/** Fills `:name` parameters of a contract path. */
export function fill(path: string, params: Record<string, string>): string {
    return path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

function errorOf(data: unknown, res: Response): string {
    if (data && typeof data === 'object') {
        // Fastify's own validation errors put the detail in `message`, the api's in `error`.
        if ('statusCode' in data && 'message' in data && typeof data.message === 'string')
            return data.message;
        if ('error' in data && typeof data.error === 'string') return data.error;
    }
    return `${res.status} ${res.statusText}`.trim();
}

export async function request<T>(method: string, path: string, opts: Options = {}): Promise<T> {
    const url = new URL(config.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {}))
        if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const auth = opts.auth !== false && token !== null;
    if (auth) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            signal: opts.signal,
        });
    } catch (err) {
        if (opts.signal?.aborted) throw err;
        throw new ApiError(0, `Cannot reach the Ember api at ${config.apiUrl}.`);
    }
    const text = res.status === 204 ? '' : await res.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
    }
    if (!res.ok) {
        if (res.status === 401 && auth) unauthorized?.();
        throw new ApiError(res.status, errorOf(data, res));
    }
    return data as T;
}

export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
