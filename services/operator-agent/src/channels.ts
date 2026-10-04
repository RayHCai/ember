/**
 * How texts reach phones. A transport only delivers: the caller has already decided the recipient
 * may be texted (an operator's approval, or the operator's own notify phone).
 */
export interface CivilianTransport {
    readonly name: string;
    /** `phone` is E.164. */
    send(phone: string, body: string): Promise<void>;
    /** Sent after the text it illustrates. */
    sendImage(phone: string, image: Buffer, mimeType: string, name: string): Promise<void>;
    close(): Promise<void>;
}

/** Delivers nowhere and says so. For development without Photon credentials. */
export class LogTransport implements CivilianTransport {
    readonly name = 'log';
    readonly sent: { phone: string; body: string }[] = [];
    readonly images: { phone: string; bytes: number; mimeType: string; name: string }[] = [];

    constructor(private readonly log: (msg: string, data: object) => void = () => {}) {}

    async send(phone: string, body: string) {
        this.sent.push({ phone, body });
        this.log('text (log transport, not delivered)', { phone, body });
    }

    async sendImage(phone: string, image: Buffer, mimeType: string, name: string) {
        this.images.push({ phone, bytes: image.length, mimeType, name });
        this.log('image (log transport, not delivered)', { phone, bytes: image.length, name });
    }

    async close() {}
}
