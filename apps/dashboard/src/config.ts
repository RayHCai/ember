const env = import.meta.env;

function clean(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

export const config = {
    ionToken: clean(env.VITE_CESIUM_ION_TOKEN),
    googleMapsKey: clean(env.VITE_GOOGLE_MAPS_API_KEY),
} as const;
