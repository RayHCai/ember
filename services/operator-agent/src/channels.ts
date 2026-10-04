/**
 * How texts reach civilians. A transport only delivers: the caller has already checked the
 * operator's approval before `send` is called.
 */
export interface CivilianTransport {
    readonly name: string;
    /** `phone` is E.164. */
    send(phone: string, body: string): Promise<void>;
    close(): Promise<void>;
}

/** Delivers nowhere and says so. For development without Photon credentials. */
export class LogTransport implements CivilianTransport {
    readonly name = 'log';
    readonly sent: { phone: string; body: string }[] = [];

    constructor(private readonly log: (msg: string, data: object) => void = () => {}) {}

    async send(phone: string, body: string) {
        this.sent.push({ phone, body });
        this.log('civilian text (log transport, not delivered)', { phone, body });
    }

    async close() {}
}
