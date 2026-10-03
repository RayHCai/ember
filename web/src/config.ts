const env = import.meta.env;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The server address. A phone that opened the resident page from the laptop's
 * network address cannot reach "localhost", so a localhost setting follows the
 * page's own host instead.
 */
function serverUrl(): string | undefined {
  const raw = clean(env.VITE_SERVER_URL);
  if (!raw) return undefined;
  const configured = raw.replace(/\/$/, "");
  const pageHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const local = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "tauri.localhost" || h === "";
  try {
    const url = new URL(configured);
    if (local(url.hostname) && !local(pageHost)) url.hostname = pageHost;
    return url.toString().replace(/\/$/, "");
  } catch {
    return configured;
  }
}

export const config = {
  /** The logic service, if one is configured. Without it the console runs on dummy data. */
  serviceUrl: serverUrl(),
  ionToken: clean(env.VITE_CESIUM_ION_TOKEN),
  googleMapsKey: clean(env.VITE_GOOGLE_MAPS_API_KEY),
} as const;

export function wsUrl(path: string): string {
  return (config.serviceUrl ?? "").replace(/^http/, "ws") + path;
}
