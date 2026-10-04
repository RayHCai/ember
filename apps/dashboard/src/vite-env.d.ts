/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_CESIUM_ION_TOKEN?: string;
    readonly VITE_GOOGLE_MAPS_API_KEY?: string;
    readonly VITE_EMBER_API_URL?: string;
    readonly VITE_EMBER_DRONE_INFO_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
