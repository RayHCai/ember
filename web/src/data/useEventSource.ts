import { useEffect } from "react";
import { startDataSource } from "./source";

/** Feeds the store from the live service, or the demo when VITE_USE_MOCK=1. */
export function useEventSource(): void {
  useEffect(() => startDataSource(), []);
}
