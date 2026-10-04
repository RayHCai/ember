import {
    RESPONDER_BUNDLE_PATH,
    RESPONDER_PAIR_PATH,
    type ResponderPairRequest,
    type ResponderPairingCode,
    type ResponderSession,
    type ResponderZoneBundle,
} from '@ember/contracts';

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

async function request(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`);
    return (await res.json()) as T;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

export async function pair(
    code: ResponderPairingCode,
    body: Omit<ResponderPairRequest, 'token'>,
): Promise<ResponderSession> {
    const req: ResponderPairRequest = { ...body, token: code.token };
    const res = await request(`${code.apiUrl}${RESPONDER_PAIR_PATH}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(req),
    });
    return json<ResponderSession>(res);
}

/** Null when the server's bundle still matches `version`. */
export async function fetchBundle(
    session: ResponderSession,
    version: string | null,
    timeoutMs?: number,
): Promise<ResponderZoneBundle | null> {
    const path = RESPONDER_BUNDLE_PATH.replace(':zoneId', encodeURIComponent(session.zoneId));
    const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${session.sessionToken}`,
    };
    if (version) headers['if-none-match'] = version;
    const res = await request(`${session.apiUrl}${path}`, { headers }, timeoutMs);
    if (res.status === 304) return null;
    return json<ResponderZoneBundle>(res);
}
