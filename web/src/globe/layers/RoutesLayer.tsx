import { Cartesian2, ClassificationType, HeightReference, LabelStyle, PolylineGlowMaterialProperty, VerticalOrigin } from "cesium";
import { useEffect } from "react";
import { useAppStore } from "../../state/store";
import { ALWAYS_ON_TOP, C, MONO_FONT, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";

/** Evacuation routes from communities to shelters. */
export function RoutesLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const routes = useAppStore((s) => (zoneId ? s.routes[zoneId] : undefined));
  const show = useAppStore((s) => s.layers.routes);
  const ds = useDataSource(viewer, "routes");

  useEffect(() => {
    if (ds) ds.show = show;
  }, [ds, show]);

  useEffect(() => {
    if (!ds) return;
    ds.entities.removeAll();
    for (const r of Object.values(routes ?? {})) {
      ds.entities.add({
        id: `route:${r.id}`,
        polyline: {
          positions: r.path.map((p) => toCartesian(p)),
          width: 9,
          clampToGround: true,
          classificationType: ClassificationType.BOTH,
          material: new PolylineGlowMaterialProperty({ color: C.signal, glowPower: 0.22 }),
        },
      });
      const end = r.path[r.path.length - 1]!;
      ds.entities.add({
        id: `route-label:${r.id}`,
        position: toCartesian(end),
        label: {
          text: `${r.community} to ${r.shelter}\n${r.distance_km.toFixed(1)} km, ${r.eta_min} min`,
          font: MONO_FONT,
          fillColor: C.signal,
          outlineColor: C.void,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 30),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: ALWAYS_ON_TOP,
        },
      });
    }
  }, [ds, routes]);

  return null;
}
