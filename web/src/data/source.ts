import { config } from "../config";
import { useAppStore } from "../state/store";
import { DemoPlayer } from "./demo/player";
import { startLiveStream } from "./liveStream";

// The console runs on its built-in dummy data. If a logic service address is
// configured (VITE_SERVER_URL), it connects there instead.

let player: DemoPlayer | null = null;
let stopLive: (() => void) | null = null;

export function startDataSource(opts: { story?: boolean } = {}): () => void {
  const { applyEvent, setConnection, setDemo } = useAppStore.getState();
  if (config.serviceUrl) {
    stopLive = startLiveStream(applyEvent, setConnection);
  } else {
    player = new DemoPlayer(applyEvent, setDemo);
    setConnection("mock");
    if (opts.story) player.startStory(true);
    else player.load();
  }
  return () => {
    stopLive?.();
    stopLive = null;
    player?.dispose();
    player = null;
  };
}

/** The dummy backend, or null when connected to a logic service. */
export function demoPlayer(): DemoPlayer | null {
  return player;
}

export function startDemo(opts: { autoplay?: boolean } = {}): void {
  player?.startStory(Boolean(opts.autoplay));
}
