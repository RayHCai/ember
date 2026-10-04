/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_CESIUM_ION_TOKEN?: string;
    readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

/** True when the dev server proxies /ember-api to the Ember api (see vite.config.ts). */
declare const __EMBER_LIVE__: boolean;
