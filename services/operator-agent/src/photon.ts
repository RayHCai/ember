import type { CivilianTransport } from './channels.js';

type Space = { send(content: unknown): Promise<unknown> };
type App = { stop?: () => Promise<void> };
type IMessage = { space: { create(user: string): Promise<Space> } };

/**
 * iMessage through Photon Spectrum. Loaded only when `PHOTON_PROJECT_ID` is set, so the agent
 * runs without the SDK's gRPC stack in development.
 */
export class PhotonTransport implements CivilianTransport {
    readonly name = 'photon-imessage';

    private constructor(
        private readonly app: App,
        private readonly imessage: IMessage,
    ) {}

    static async connect(projectId: string, projectSecret: string): Promise<PhotonTransport> {
        const core = (await import('@spectrum-ts/core')) as unknown as {
            Spectrum(opts: object): Promise<App>;
        };
        const provider = (await import('@spectrum-ts/imessage')) as unknown as {
            imessage: { config(): unknown } & ((app: App) => IMessage);
        };
        const app = await core.Spectrum({
            projectId,
            projectSecret,
            providers: [provider.imessage.config()],
        });
        return new PhotonTransport(app, provider.imessage(app));
    }

    async send(phone: string, body: string) {
        const space = await this.imessage.space.create(phone);
        await space.send(body);
    }

    async close() {
        await this.app.stop?.();
    }
}
