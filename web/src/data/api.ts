import { config } from "../config";
import { pushToast } from "../state/toasts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Calls the server and turns failures into readable errors. */
export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(config.serverUrl + path, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(`Cannot reach the Ember server at ${config.serverUrl}. Is it running?`, 0);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
      else if (body.detail) detail = JSON.stringify(body.detail);
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/** Runs an action and shows a toast if it fails. Returns undefined on failure. */
export async function attempt<T>(what: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (err) {
    const message =
      err instanceof ApiError && err.status === 501
        ? "The logic service does not support this yet. Run the demo to see it."
        : err instanceof Error
          ? err.message
          : String(err);
    pushToast(`${what} failed. ${message}`, "error");
    return undefined;
  }
}
