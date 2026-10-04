import { copyFile } from 'node:fs/promises';

// public/ is what Vercel serves, so the shared Ember mark is copied in rather than committed twice.
await copyFile(
    new URL('../../assets/brand/icon.svg', import.meta.url),
    new URL('public/icon.svg', import.meta.url),
);
