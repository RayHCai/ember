import { config } from "../config";
import { useAppStore } from "../state/store";
import { DemoPlayer } from "./demo/player";
import { startLiveStream } from "./liveStream";

// One data source feeds the console at a time: the live service, or the demo
// player. Running the demo pauses the live connection; leaving it reconnects.

let player: DemoPlayer | null = null;
let stopLive: (() => void) | null = null;

function startLive(): void {
  const { applyEvent, setConnection } = useAppStore.getState();
  stopLive?.();
  stopLive = startLiveStream(applyEvent, setConnection);
}

export function startDataSource(): () => void {
  if (config.useMock) startDemo({ autoplay: true });
  else startLive();
  return () => {
    stopLive?.();
    stopLive = null;
    player?.dispose();
    player = null;
  };
}

export function demoPlayer(): DemoPlayer | null {
  return player;
}

/** Demo data drives the console (and its sim clock is local). */
export function inDemo(): boolean {
  return player !== null;
}

export function startDemo(opts: { autoplay?: boolean } = {}): void {
  const { applyEvent, setConnection, setDemo } = useAppStore.getState();
  stopLive?.();
  stopLive = null;
  player?.dispose();
  player = new DemoPlayer(applyEvent, setDemo);
  setConnection("mock");
  player.reset();
  if (opts.autoplay) player.play();
}

export function exitDemo(): void {
  player?.dispose();
  player = null;
  useAppStore.getState().setDemo({ status: "off", step: 0, steps: 0, label: "" });
  if (!config.useMock) startLive();
}
