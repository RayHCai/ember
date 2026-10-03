import { useEffect } from "react";
import { config } from "../config";
import { useAppStore } from "../state/store";
import { startLiveStream } from "./liveStream";
import { startMockStream } from "./mockStream";

/** Feeds the store from the mock stream (VITE_USE_MOCK=1) or the live server. */
export function useEventSource(): void {
  useEffect(() => {
    const { applyEvent, setConnection } = useAppStore.getState();
    if (config.useMock) {
      setConnection("mock");
      return startMockStream(applyEvent);
    }
    return startLiveStream(applyEvent, setConnection);
  }, []);
}
