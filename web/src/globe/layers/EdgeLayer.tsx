import {
  CallbackProperty,
  ClassificationType,
  ColorMaterialProperty,
  HeightReference,
  JulianDate,
  VerticalOrigin,
  type Entity,
} from "cesium";
import { useEffect, useMemo } from "react";
import { selectZoneServers, useAppStore } from "../../state/store";
import { prefersReducedMotion } from "../camera";
import { ALWAYS_ON_TOP, C, EDGE_ICON, EDGE_ICON_PENDING, circleRing, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";

/** Pending rings breathe so it is clear they are not deployed yet. */
function pulsingRing(): ColorMaterialProperty {
  if (prefersReducedMotion()) return new ColorMaterialProperty(C.signal.withAlpha(0.6));
  return new ColorMaterialProperty(
    new CallbackProperty((time) => {
      const t = JulianDate.toDate(time ?? JulianDate.now()).getTime() / 1000;
      return C.signal.withAlpha(0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3)));
    }, false),
  );
}

/** Edge servers (drone docks) and their coverage rings for the active zone. */
export function EdgeLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const servers = useAppStore((s) => selectZoneServers(s, zoneId));
  const show = useAppStore((s) => s.layers.edgeServers);
  const ds = useDataSource(viewer, "edge-servers");
  const pulse = useMemo(pulsingRing, []);

  useEffect(() => {
    if (ds) ds.show = show;
  }, [ds, show]);

  useEffect(() => {
    if (!ds) return;
    const keep = new Set<string>();
    for (const server of servers) {
      const pending = server.status === "pending";
      const iconId = `edge:${server.id}`;
      const ringId = `edge-ring:${server.id}`;
      keep.add(iconId).add(ringId);
      const position = toCartesian([server.lat, server.lon]);
      const ring = circleRing([server.lat, server.lon], server.radius_m);
      const material = pending ? pulse : new ColorMaterialProperty(C.signal.withAlpha(0.55));

      const icon: Entity | undefined = ds.entities.getById(iconId);
      if (icon) {
        icon.position = position as never;
        if (icon.billboard) icon.billboard.image = (pending ? EDGE_ICON_PENDING : EDGE_ICON) as never;
      } else {
        ds.entities.add({
          id: iconId,
          position,
          billboard: {
            image: pending ? EDGE_ICON_PENDING : EDGE_ICON,
            width: 28,
            height: 28,
            verticalOrigin: VerticalOrigin.CENTER,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: ALWAYS_ON_TOP,
          },
        });
      }
      const ringEntity: Entity | undefined = ds.entities.getById(ringId);
      if (ringEntity?.polyline) {
        ringEntity.polyline.positions = ring as never;
        ringEntity.polyline.material = material;
      } else {
        ds.entities.add({
          id: ringId,
          polyline: {
            positions: ring,
            width: 2,
            clampToGround: true,
            classificationType: ClassificationType.BOTH,
            material,
          },
        });
      }
    }
    for (const entity of [...ds.entities.values]) {
      if (!keep.has(entity.id)) ds.entities.remove(entity);
    }
  }, [ds, servers, pulse]);

  return null;
}
