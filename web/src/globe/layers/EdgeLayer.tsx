import {
  CallbackProperty,
  Cartesian2,
  ClassificationType,
  ColorMaterialProperty,
  HeightReference,
  JulianDate,
  LabelStyle,
  VerticalOrigin,
  type Entity,
} from "cesium";
import { useEffect, useMemo } from "react";
import { selectZoneServers, useAppStore } from "../../state/store";
import { useTelemetry } from "../../state/telemetry";
import { prefersReducedMotion } from "../camera";
import { ALWAYS_ON_TOP, C, EDGE_ICON, EDGE_ICON_PENDING, MONO_FONT, circleRing, toCartesian } from "../style";
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

  // Deployed docks say how many drones are home and whether they are charging.
  useEffect(() => {
    if (!ds) return;
    const label = () => {
      const drones = Object.values(useTelemetry.getState().drones);
      for (const server of servers) {
        const icon = ds.entities.getById(`edge:${server.id}`);
        if (!icon) continue;
        if (server.status !== "deployed") {
          icon.label = undefined;
          continue;
        }
        const mine = drones.filter((d) => d.dock_id === server.id);
        const home = mine.filter((d) => d.state === "docked" || d.state === "charging");
        const status =
          mine.length === 0 ? "" : home.length === 0 ? "all out" : home.some((d) => d.state === "charging") ? "charging" : "ready";
        const text = mine.length ? `${home.length}/${mine.length} home · ${status}` : server.id;
        if (icon.label) {
          icon.label.text = text as never;
        } else {
          icon.label = {
            text,
            font: MONO_FONT,
            fillColor: C.text,
            outlineColor: C.void,
            outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: VerticalOrigin.TOP,
            pixelOffset: new Cartesian2(0, 18),
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: ALWAYS_ON_TOP,
          } as never;
        }
      }
    };
    label();
    const timer = window.setInterval(label, 1000);
    return () => window.clearInterval(timer);
  }, [ds, servers]);

  return null;
}
