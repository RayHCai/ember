import { Cartesian3, PointPrimitiveCollection, type Color } from "cesium";
import { useEffect } from "react";
import { useAppStore } from "../../state/store";
import type { Tier } from "../../types/events";
import { ALWAYS_ON_TOP, C } from "../style";

export const TIER_COLOR: Record<Tier, Color> = { evacuate: C.heat, prepare: C.warn, watch: C.signal };

/** Simulated residents as dots colored by alert tier (one primitive collection, not entities). */
export function RecipientsLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const recipients = useAppStore((s) => (zoneId ? s.recipients[zoneId] : undefined));
  const show = useAppStore((s) => s.layers.recipients);

  useEffect(() => {
    if (!viewer || !recipients) return;
    const points = new PointPrimitiveCollection();
    for (const r of recipients.residents) {
      points.add({
        position: Cartesian3.fromDegrees(r.lon, r.lat),
        pixelSize: r.tier ? 6 : 4,
        color: r.tier ? TIER_COLOR[r.tier] : C.muted.withAlpha(0.6),
        outlineColor: C.void,
        outlineWidth: 1,
        disableDepthTestDistance: ALWAYS_ON_TOP,
      });
    }
    points.show = show;
    viewer.scene.primitives.add(points);
    return () => {
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(points);
    };
  }, [viewer, recipients, show]);

  return null;
}
