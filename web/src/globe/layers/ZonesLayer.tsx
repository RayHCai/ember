import { ClassificationType, PolygonHierarchy } from "cesium";
import { useEffect } from "react";
import { useAppStore } from "../../state/store";
import { C, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";

/** Every watch zone's outline. The active zone is brighter. */
export function ZonesLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zones = useAppStore((s) => s.zones);
  const activeId = useAppStore((s) => s.activeZoneId);
  const ds = useDataSource(viewer, "zones");

  useEffect(() => {
    if (!ds) return;
    ds.entities.removeAll();
    for (const zone of Object.values(zones)) {
      const active = zone.id === activeId;
      const positions = zone.polygon.map((p) => toCartesian(p));
      ds.entities.add({
        id: `zone-fill:${zone.id}`,
        polygon: {
          hierarchy: new PolygonHierarchy(positions),
          material: C.signal.withAlpha(active ? 0.06 : 0.03),
          classificationType: ClassificationType.BOTH,
        },
      });
      ds.entities.add({
        id: `zone-edge:${zone.id}`,
        polyline: {
          positions: [...positions, positions[0]!],
          width: active ? 2.5 : 1.5,
          clampToGround: true,
          material: C.signal.withAlpha(active ? 0.95 : 0.45),
          classificationType: ClassificationType.BOTH,
        },
      });
    }
  }, [ds, zones, activeId]);

  return null;
}
