import { useEffect, useRef } from "react";
import { computeCoverage } from "../../geo/grid";
import { selectZoneServers, useAppStore } from "../../state/store";
import { GridOverlay } from "../gridOverlay";

const UNCOVERED: [number, number, number, number] = [110, 141, 150, 120];

/** Shades in-zone cells that no edge server reaches. */
export function CoverageLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const grid = useAppStore((s) => (zoneId ? s.zoneMaps[zoneId]?.grid : undefined));
  const servers = useAppStore((s) => selectZoneServers(s, zoneId));
  const show = useAppStore((s) => s.layers.coverage);
  const overlay = useRef<GridOverlay | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    if (!viewer || !grid) return;
    overlay.current = new GridOverlay(viewer, grid);
    return () => {
      overlay.current?.destroy();
      overlay.current = null;
    };
  }, [viewer, grid]);

  useEffect(() => {
    const o = overlay.current;
    if (!o || !grid) return;
    o.show = show && servers.length > 0;
    if (servers.length === 0) return;
    // Dragging fires many updates; repaint at most once per frame.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const { covered } = computeCoverage(grid, servers);
      o.paint((i) => (grid.in_zone.charCodeAt(i) === 49 && !covered[i] ? UNCOVERED : null));
    });
  }, [grid, servers, show]);

  return null;
}
