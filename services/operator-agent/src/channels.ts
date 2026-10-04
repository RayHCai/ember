import type { Civilian, CivilianChannel } from '@ember/contracts';

/** Where a civilian's texts go: their phone when known, else their Apple ID email. */
export const handleOf = (c: Pick<Civilian, 'phone' | 'email'>) => c.phone ?? c.email;

export type InboundText = {
    /** Email or phone the civilian wrote from. */
    handle: string;
    channel: CivilianChannel;
    body: string;
    attachments: { url: string; mimeType: string }[];
};

/**
 * How texts reach civilians. A transport only delivers: the api has already accepted the
 * message (approval or open conversation) before `send` is called.
 */
export interface CivilianTransport {
    readonly name: string;
    send(handle: string, body: string): Promise<void>;
    /** Sent after the text it illustrates. */
    sendImage(handle: string, image: Buffer, mimeType: string): Promise<void>;
    /** Inbound texts, for transports that receive; the agent records each at the api. */
    inbound(): AsyncIterable<InboundText> | null;
    close(): Promise<void>;
}

/** Delivers nowhere and says so; the api still records every message. For development. */
export class LogTransport implements CivilianTransport {
    readonly name = 'log';
    readonly sent: { handle: string; body: string }[] = [];
    readonly images: { handle: string; bytes: number; mimeType: string }[] = [];

    constructor(private readonly log: (msg: string, data: object) => void = () => {}) {}

    async send(handle: string, body: string) {
        this.sent.push({ handle, body });
        this.log('civilian text (log transport, not delivered)', { handle, body });
    }

    async sendImage(handle: string, image: Buffer, mimeType: string) {
        this.images.push({ handle, bytes: image.length, mimeType });
        this.log('civilian image (log transport, not delivered)', {
            handle,
            bytes: image.length,
            mimeType,
        });
    }

    inbound() {
        return null;
    }

    async close() {}
}
