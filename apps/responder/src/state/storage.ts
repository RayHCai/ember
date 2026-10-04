import { Directory, File, Paths } from 'expo-file-system';
import type { ResponderMessage, ResponderSession, ResponderZoneBundle } from '@ember/contracts';

/** What survives a restart. The bundle is kept in its own file: it is the large one. */
export type FeedState = {
    messages: ResponderMessage[];
    lastReadAt: string | null;
    lastSyncedAt: string | null;
};

const dir = new Directory(Paths.document, 'ember');
const files = {
    session: new File(dir, 'session.json'),
    bundle: new File(dir, 'bundle.json'),
    feed: new File(dir, 'feed.json'),
};

async function read<T>(file: File): Promise<T | null> {
    try {
        return file.exists ? (JSON.parse(await file.text()) as T) : null;
    } catch {
        return null;
    }
}

/** Via a temp file so a crash mid-write never leaves a half bundle behind. */
async function write(file: File, value: unknown): Promise<void> {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const tmp = new File(dir, `${file.name}.tmp`);
    tmp.write(JSON.stringify(value));
    await tmp.move(file, { overwrite: true });
}

export async function loadAll() {
    const [session, bundle, feed] = await Promise.all([
        read<ResponderSession>(files.session),
        read<ResponderZoneBundle>(files.bundle),
        read<FeedState>(files.feed),
    ]);
    return { session, bundle, feed };
}

export const save = {
    session: (s: ResponderSession) => write(files.session, s),
    bundle: (b: ResponderZoneBundle) => write(files.bundle, b),
    feed: (f: FeedState) => write(files.feed, f),
};

export function clearAll(): void {
    if (dir.exists) dir.delete();
}
