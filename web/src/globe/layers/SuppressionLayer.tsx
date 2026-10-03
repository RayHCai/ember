import { useEffect, useMemo } from "react";
import { selectActiveIncident, useAppStore } from "../../state/store";
import { GridOverlay, type CellColor } from "../gridOverlay";
import { spreadGrid } from "../spreadGrid";

const TREATED: CellColor = [63, 224, 255, 150];

/** Cells treated by (simulated) suppression drones, as one image over the fire. */
export function SuppressionLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const incident = useAppStore(selectActiveIncident);
  const suppression = useAppStore((s) => (incident ? s.suppression[incident.id] : undefined));
  const spread = useAppStore((s) => (s.activeZoneId ? s.spread[s.activeZoneId] : undefined));
  const show = useAppStore((s) => s.layers.suppression);

  // The grid of the first prediction for this incident, so it stays put as the fire shrinks.
  const sg = useMemo(() => (spread && incident && spread.incident_id === incident.id ? spreadGrid(spread) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [incident?.id, Boolean(spread)]);

  useEffect(() => {
    if (!viewer || !sg || !suppression || suppression.treated_cells.length === 0) return;
    const { grid } = sg;
    const treated = new Set<number>();
    for (const [lat, lon] of suppression.treated_cells) {
      const row = Math.floor((lat - grid.south) / grid.dlat);
      const col = Math.floor((lon - grid.west) / grid.dlon);
      if (row >= 0 && row < grid.rows && col >= 0 && col < grid.cols) treated.add(row * grid.cols + col);
    }
    const overlay = new GridOverlay(viewer, grid);
    overlay.paint((i) => (treated.has(i) ? TREATED : null));
    overlay.show = show;
    return () => overlay.destroy();
  }, [viewer, sg, suppression, show]);

  return null;
}
