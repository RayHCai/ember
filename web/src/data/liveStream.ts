import { wsUrl } from "../config";
import type { ConnectionState } from "../state/store";
import type { KnownEvent } from "../types/events";

const MAX_BACKOFF_MS = 5000;

/**
 * Connects to the server's /ws stream and reconnects with backoff when it
 * drops. The server sends a fresh snapshot on every connect, so state
 * recovers on its own after a restart.
 */
export function startLiveStream(
  onEvent: (event: KnownEvent) => void,
  onState: (state: ConnectionState) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let everOpened = false;
  let attempt = 0;
  let timer = 0;

  const waiting = (): ConnectionState => (everOpened ? "reconnecting" : "connecting");

  const connect = () => {
    onState(waiting());
    socket = new WebSocket(wsUrl("/ws"));
    socket.onopen = () => {
      attempt = 0;
      everOpened = true;
      onState("open");
    };
    socket.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data as string) as KnownEvent);
      } catch (err) {
        console.warn("Ignored an event that was not valid JSON", err);
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      onState(waiting());
      const delay = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      timer = window.setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    socket?.close();
  };
}
