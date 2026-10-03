import { useEffect } from "react";
import { config } from "../config";
import { useAppStore } from "../state/store";
import { startMockStream } from "./mockStream";

/** Feeds the store from the mock stream or the live server. */
export function useEventSource(): void {
  useEffect(() => {
    const { applyEvent, setConnection } = useAppStore.getState();
    if (config.useMock) {
      setConnection("mock");
      return startMockStream(applyEvent);
    }
    setConnection("connecting");
    return undefined;
  }, []);
}
