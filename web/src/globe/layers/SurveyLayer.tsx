import { useEffect } from "react";
import { useObserved } from "../../state/observed";
import { useAppStore } from "../../state/store";
import { GridOverlay } from "../gridOverlay";

const OBSERVED: [number, number, number, number] = [63, 224, 255, 46];
const REPAINT_MS = 400;

/** Cells the running survey has imaged, filled in lightly so the sweep is visible. */
export function SurveyLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const grid = useAppStore((s) => (zoneId ? s.zoneMaps[zoneId]?.grid : undefined));

  useEffect(() => {
    if (!viewer || !grid || !zoneId) return;
    const overlay = new GridOverlay(viewer, grid);
    let timer = 0;
    let painted = -1;
    const paint = () => {
      timer = 0;
      const observed = useObserved.getState().zones[zoneId];
      if (!observed || observed.version === painted) return;
      painted = observed.version;
      overlay.paint((i) => (observed.cells.has(i) ? OBSERVED : null));
    };
    paint();
    const unsubscribe = useObserved.subscribe(() => {
      if (!timer) timer = window.setTimeout(paint, REPAINT_MS);
    });
    // Visible while this zone's survey runs and the layer is on.
    const visible = (s = useAppStore.getState()) =>
      s.layers.surveyHeatmap && s.surveys[zoneId]?.status === "running";
    overlay.show = visible();
    const unsubscribeStore = useAppStore.subscribe((s) => {
      overlay.show = visible(s);
    });
    return () => {
      unsubscribe();
      unsubscribeStore();
      window.clearTimeout(timer);
      overlay.destroy();
    };
  }, [viewer, grid, zoneId]);

  return null;
}
