import type { Viewer } from "cesium";
import { useEffect, useRef } from "react";
import { selectActiveZone, useAppStore } from "../state/store";
import { flyToPoint, flyToPoints } from "./camera";
import { DEFAULT_LOCATION } from "./presets";

/**
 * The one orchestrated animation on load: from the whole-earth view, fly once
 * to the active zone, or to the default location if no zone arrives quickly.
 */
export function useOpeningFlight(): void {
  const viewer = useAppStore((s) => s.viewer);
  const mapReady = useAppStore((s) => s.mapSource !== null);
  const zone = useAppStore(selectActiveZone);
  const flownFor = useRef<Viewer | null>(null);

  useEffect(() => {
    if (!viewer || !mapReady || flownFor.current === viewer) return;
    const timer = window.setTimeout(
      () => {
        if (viewer.isDestroyed()) return;
        flownFor.current = viewer;
        if (zone) {
          void flyToPoints(viewer, zone.polygon, { duration: 4 });
        } else {
          const { lat, lon, range } = DEFAULT_LOCATION;
          void flyToPoint(viewer, lat, lon, { range, duration: 4 });
        }
      },
      zone ? 600 : 1500,
    );
    return () => window.clearTimeout(timer);
  }, [viewer, mapReady, zone]);
}
