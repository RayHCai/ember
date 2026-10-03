import {
  ClassificationType,
  DistanceDisplayCondition,
  HeightReference,
  LabelStyle,
  NearFarScalar,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  Cartesian2,
} from "cesium";
import { useEffect } from "react";
import { useAppStore } from "../../state/store";
import { ALWAYS_ON_TOP, C, LABEL_FONT, SHELTER_ICON, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";

const LABEL = {
  font: LABEL_FONT,
  fillColor: C.text,
  outlineColor: C.void,
  outlineWidth: 3,
  style: LabelStyle.FILL_AND_OUTLINE,
  verticalOrigin: VerticalOrigin.BOTTOM,
  heightReference: HeightReference.CLAMP_TO_GROUND,
  disableDepthTestDistance: ALWAYS_ON_TOP,
  distanceDisplayCondition: new DistanceDisplayCondition(0, 80_000),
  scaleByDistance: new NearFarScalar(2_000, 1, 60_000, 0.75),
};

/** Roads, communities and shelters around the active zone. */
export function PlacesLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const map = useAppStore((s) => (zoneId ? s.zoneMaps[zoneId] : undefined));
  const draft = useAppStore((s) => (s.shelterDraft?.zoneId === zoneId ? s.shelterDraft : null));
  const show = useAppStore((s) => s.layers.places);
  const ds = useDataSource(viewer, "places");

  useEffect(() => {
    if (ds) ds.show = show;
  }, [ds, show]);

  // Roads and communities change only when the zone's map data does.
  useEffect(() => {
    if (!ds) return;
    const keep = new Set<string>();
    if (map) {
      const synthetic = map.source === "synthetic";
      for (const road of map.roads) {
        const id = `road:${road.id}`;
        keep.add(id);
        if (ds.entities.getById(id)) continue;
        const major = /primary|secondary/.test(road.kind);
        ds.entities.add({
          id,
          polyline: {
            positions: road.points.map((p) => toCartesian(p)),
            width: major ? 2.2 : 1.4,
            clampToGround: true,
            classificationType: ClassificationType.BOTH,
            material: synthetic
              ? new PolylineDashMaterialProperty({ color: C.muted.withAlpha(0.7), dashLength: 12 })
              : C.text.withAlpha(major ? 0.55 : 0.35),
          },
        });
      }
      for (const c of map.communities) {
        const id = `community:${c.id}`;
        keep.add(id);
        if (ds.entities.getById(id)) continue;
        ds.entities.add({
          id,
          position: toCartesian([c.lat, c.lon]),
          point: {
            pixelSize: 7,
            color: C.text,
            outlineColor: C.void,
            outlineWidth: 2,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: ALWAYS_ON_TOP,
          },
          label: { ...LABEL, text: c.name, pixelOffset: new Cartesian2(0, -10) },
        });
      }
    }
    for (const entity of [...ds.entities.values]) {
      if ((entity.id.startsWith("road:") || entity.id.startsWith("community:")) && !keep.has(entity.id)) {
        ds.entities.remove(entity);
      }
    }
  }, [ds, map]);

  // Shelters follow the working copy while the operator edits them.
  useEffect(() => {
    if (!ds) return;
    const shelters = draft?.shelters ?? map?.shelters ?? [];
    const keep = new Set<string>();
    for (const s of shelters) {
      const id = `shelter:${s.id}`;
      keep.add(id);
      const position = toCartesian([s.lat, s.lon]);
      const existing = ds.entities.getById(id);
      if (existing) {
        existing.position = position as never;
        if (existing.label) existing.label.text = s.name as never;
        continue;
      }
      ds.entities.add({
        id,
        position,
        billboard: {
          image: SHELTER_ICON,
          width: 24,
          height: 24,
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: ALWAYS_ON_TOP,
        },
        label: { ...LABEL, text: s.name, pixelOffset: new Cartesian2(0, -28) },
      });
    }
    for (const entity of [...ds.entities.values]) {
      if (entity.id.startsWith("shelter:") && !keep.has(entity.id)) ds.entities.remove(entity);
    }
  }, [ds, map, draft]);

  return null;
}
