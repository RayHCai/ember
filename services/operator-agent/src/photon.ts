import type { CivilianTransport, InboundText } from './channels.js';

type Content = { type: string; text?: string; id?: string; mimeType?: string };
type Space = { send(content: unknown): Promise<unknown> };
type Message = { content: Content; direction: 'inbound' | 'outbound'; sender?: { id: string } };
type App = {
    messages: AsyncIterable<[Space, Message]>;
    stop?: () => Promise<void>;
};
type IMessage = { space: { create(user: string): Promise<Space> } };
type Attachment = (input: Buffer, options: { mimeType: string; name: string }) => unknown;

/**
 * iMessage through Photon Spectrum. Loaded only when `PHOTON_PROJECT_ID` is set, so the agent
 * runs without the SDK's gRPC stack in development.
 */
export class PhotonTransport implements CivilianTransport {
    readonly name = 'photon-imessage';

    private constructor(
        private readonly app: App,
        private readonly imessage: IMessage,
        private readonly attachment: Attachment,
    ) {}

    static async connect(projectId: string, projectSecret: string): Promise<PhotonTransport> {
        const core = (await import('@spectrum-ts/core')) as unknown as {
            Spectrum(opts: object): Promise<App>;
            attachment: Attachment;
        };
        const provider = (await import('@spectrum-ts/imessage')) as unknown as {
            imessage: { config(): unknown } & ((app: App) => IMessage);
        };
        const app = await core.Spectrum({
            projectId,
            projectSecret,
            providers: [provider.imessage.config()],
        });
        return new PhotonTransport(app, provider.imessage(app), core.attachment);
    }

    async send(handle: string, body: string) {
        const space = await this.imessage.space.create(handle);
        await space.send(body);
    }

    async sendImage(handle: string, image: Buffer, mimeType: string) {
        const space = await this.imessage.space.create(handle);
        await space.send(this.attachment(image, { mimeType, name: 'ember-evacuation-map.png' }));
    }

    async *inbound(): AsyncIterable<InboundText> {
        for await (const [, message] of this.app.messages) {
            if (message.direction !== 'inbound' || !message.sender) continue;
            const c = message.content;
            yield {
                handle: message.sender.id,
                channel: 'imessage',
                body: c.type === 'text' ? (c.text ?? '') : '',
                attachments:
                    c.type === 'attachment' && c.id
                        ? [
                              {
                                  url: `photon-attachment:${c.id}`,
                                  mimeType: c.mimeType ?? 'application/octet-stream',
                              },
                          ]
                        : [],
            };
        }
    }

    async close() {
        await this.app.stop?.();
    }
}
