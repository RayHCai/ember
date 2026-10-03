import { useEffect } from "react";
import { startDataSource } from "./source";

/** Feeds the store from the built-in dummy data (or a logic service, if configured). */
export function useEventSource(): void {
  useEffect(() => startDataSource(), []);
}
