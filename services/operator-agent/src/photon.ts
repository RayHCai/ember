import type { CivilianTransport } from './channels.js';

type Space = { send(content: unknown): Promise<unknown> };
type Inbound = {
    direction: 'inbound' | 'outbound';
    sender: { id: string } | undefined;
    content: { type: string; text?: string };
};
type App = { stop?: () => Promise<void>; messages: AsyncIterable<[unknown, Inbound]> };
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

    async send(phone: string, body: string) {
        const space = await this.imessage.space.create(phone);
        await space.send(body);
    }

    async sendImage(phone: string, image: Buffer, mimeType: string, name: string) {
        const space = await this.imessage.space.create(phone);
        await space.send(this.attachment(image, { mimeType, name }));
    }

    listen(onText: (from: string, text: string) => Promise<void>) {
        void (async () => {
            for await (const [, message] of this.app.messages) {
                const { direction, sender, content } = message;
                if (direction !== 'inbound' || !sender || content.type !== 'text' || !content.text)
                    continue;
                // oxlint-disable-next-line no-await-in-loop -- one text at a time, in order
                await onText(sender.id, content.text).catch(() => {});
            }
        })();
    }

    async close() {
        await this.app.stop?.();
    }
}
