const env = import.meta.env;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const config = {
  serverUrl: (clean(env.VITE_SERVER_URL) ?? "http://localhost:8000").replace(/\/$/, ""),
  ionToken: clean(env.VITE_CESIUM_ION_TOKEN),
  googleMapsKey: clean(env.VITE_GOOGLE_MAPS_API_KEY),
  useMock: env.VITE_USE_MOCK === "1" || env.VITE_USE_MOCK === "true",
} as const;

export function wsUrl(path: string): string {
  return config.serverUrl.replace(/^http/, "ws") + path;
}
