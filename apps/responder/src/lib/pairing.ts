import {
    RESPONDER_PAIRING_KIND,
    type ResponderPairingCode,
    type WatchZoneId,
} from '@ember/contracts';

export const DEMO_PAIRING_TOKEN = 'demo';

export type PairingParse =
    | { ok: true; code: ResponderPairingCode }
    | { ok: false; reason: 'not_ember' | 'expired' | 'invalid' };

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function isHttpUrl(v: unknown): v is string {
    return typeof v === 'string' && /^https?:\/\/\S+$/.test(v);
}

/** Reads a scanned QR code; the scanner ignores anything that is not an Ember pairing code. */
export function parsePairingCode(text: string, now = Date.now()): PairingParse {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'not_ember' };
    }
    if (!isRecord(raw) || raw.kind !== RESPONDER_PAIRING_KIND) {
        return { ok: false, reason: 'not_ember' };
    }
    const { v, apiUrl, zoneId, zoneName, token, expiresAt } = raw;
    if (
        v !== 1 ||
        !isHttpUrl(apiUrl) ||
        typeof zoneId !== 'string' ||
        typeof zoneName !== 'string' ||
        typeof token !== 'string' ||
        token.length === 0 ||
        typeof expiresAt !== 'string' ||
        Number.isNaN(Date.parse(expiresAt))
    ) {
        return { ok: false, reason: 'invalid' };
    }
    if (Date.parse(expiresAt) < now) return { ok: false, reason: 'expired' };
    return {
        ok: true,
        code: {
            kind: RESPONDER_PAIRING_KIND,
            v: 1,
            apiUrl: apiUrl.replace(/\/+$/, ''),
            zoneId: zoneId as WatchZoneId,
            zoneName,
            token,
            expiresAt,
        },
    };
}
