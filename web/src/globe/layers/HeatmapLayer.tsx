import { useEffect } from "react";
import { selectActiveIncident, useAppStore } from "../../state/store";
import type { GridInfo, ReportCell } from "../../types/events";
import { GridOverlay, type CellColor } from "../gridOverlay";

const WARN = [255, 176, 32] as const;
const HEAT = [255, 59, 47] as const;

/** Score 0 to 100: transparent below 40, then warn, then heat. Danger colors only. */
export function scoreColor(score: number): CellColor {
  if (score < 40) return null;
  const t = Math.min(1, Math.max(0, (score - 55) / 30));
  const mix = (i: 0 | 1 | 2) => Math.round(WARN[i] + (HEAT[i] - WARN[i]) * t);
  const alpha = Math.round(255 * (0.18 + 0.47 * Math.min(1, (score - 40) / 50)));
  return [mix(0), mix(1), mix(2), alpha];
}

function cellIndex(grid: GridInfo, c: ReportCell): number | null {
  const row = Math.floor((c.lat - grid.south) / grid.dlat);
  const col = Math.floor((c.lon - grid.west) / grid.dlon);
  return row >= 0 && row < grid.rows && col >= 0 && col < grid.cols ? row * grid.cols + col : null;
}

/** The latest report's vulnerability scores, as one image draped over the zone. */
export function HeatmapLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const grid = useAppStore((s) => (zoneId ? s.zoneMaps[zoneId]?.grid : undefined));
  const report = useAppStore((s) => (zoneId ? s.reports[zoneId] : undefined));
  const show = useAppStore((s) => s.layers.surveyHeatmap);
  const surveying = useAppStore((s) => (zoneId ? s.surveys[zoneId]?.status === "running" : false));
  // While a fire burns, the risk heatmap steps back so it is not mistaken for the fire.
  const fireActive = useAppStore((s) => {
    const i = selectActiveIncident(s);
    return Boolean(i && i.status !== "contained");
  });

  useEffect(() => {
    if (!viewer || !grid || !report) return;
    const overlay = new GridOverlay(viewer, grid);
    const scores = new Map<number, number>();
    for (const c of report.cells) {
      const i = cellIndex(grid, c);
      if (i !== null) scores.set(i, c.score);
    }
    overlay.paint((i) => {
      const score = scores.get(i);
      const color = score === undefined ? null : scoreColor(score);
      return color && fireActive ? [color[0], color[1], color[2], Math.round(color[3] * 0.35)] : color;
    });
    overlay.show = show && !surveying;
    return () => overlay.destroy();
  }, [viewer, grid, report, show, surveying, fireActive]);

  return null;
}
