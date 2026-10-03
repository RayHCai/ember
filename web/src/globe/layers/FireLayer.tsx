import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  ClassificationType,
  HeightReference,
  JulianDate,
  LabelStyle,
  PolylineArrowMaterialProperty,
  VerticalOrigin,
} from "cesium";
import { useEffect, useMemo, useRef } from "react";
import { projector } from "../../geo/grid";
import { formatMinutes } from "../../lib/time";
import { selectActiveIncident, useAppStore } from "../../state/store";
import { prefersReducedMotion } from "../camera";
import { GridOverlay, type CellColor } from "../gridOverlay";
import { spreadGrid } from "../spreadGrid";
import { ALWAYS_ON_TOP, C, MONO_FONT, fireIcon, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";

const FRONT: CellColor = [255, 59, 47, 220];
const BURNED: CellColor = [110, 22, 16, 105];
const FRONT_MIN = 30;

/** The active incident: marker, predicted spread up to the scrubber time, head arrow, arrival times. */
export function FireLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const incident = useAppStore(selectActiveIncident);
  const spread = useAppStore((s) => (zoneId ? s.spread[zoneId] : undefined));
  const minutes = useAppStore((s) => s.spreadMinutes);
  const show = useAppStore((s) => s.layers.fireSpread);
  const ds = useDataSource(viewer, "fire");
  const overlay = useRef<GridOverlay | null>(null);
  const frame = useRef(0);

  const current = spread && incident && spread.incident_id === incident.id ? spread : undefined;

  // One grid per incident, from its first prediction (the widest). Later
  // predictions repaint the same overlay: rebuilding a ground primitive on
  // every update would keep it from ever appearing.
  const base = useRef<{ incidentId: string; sg: NonNullable<ReturnType<typeof spreadGrid>> } | null>(null);
  if (current && base.current?.incidentId !== current.incident_id) {
    const sg = spreadGrid(current);
    base.current = sg ? { incidentId: current.incident_id, sg } : null;
  }
  const grid = base.current && current ? base.current.sg.grid : null;
  const arrival = useMemo(() => {
    if (!grid || !current) return null;
    const out = new Float32Array(grid.rows * grid.cols).fill(Number.POSITIVE_INFINITY);
    for (const [lat, lon, m] of current.cells) {
      const row = Math.floor((lat - grid.south) / grid.dlat);
      const col = Math.floor((lon - grid.west) / grid.dlon);
      if (row >= 0 && row < grid.rows && col >= 0 && col < grid.cols) out[row * grid.cols + col] = m;
    }
    return out;
  }, [grid, current]);

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
    if (!o || !arrival) return;
    o.show = show && incident?.status !== "contained";
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() =>
      o.paint((i) => {
        const m = arrival[i]!;
        if (m > minutes) return null;
        return m > minutes - FRONT_MIN ? FRONT : BURNED;
      }),
    );
  }, [arrival, minutes, show, incident?.status]);

  // Marker, head arrow and community arrival labels.
  useEffect(() => {
    if (!ds) return;
    ds.entities.removeAll();
    if (!incident) return;
    const color = incident.status === "suspected" ? "#FFB020" : incident.status === "contained" ? "#6E8D96" : "#FF3B2F";
    const at = toCartesian([incident.lat, incident.lon]);
    const pulse = !prefersReducedMotion() && incident.status !== "contained";
    ds.entities.add({
      id: `incident:${incident.id}`,
      position: at,
      billboard: {
        image: fireIcon(color),
        width: 34,
        height: 34,
        scale: pulse
          ? new CallbackProperty((t) => 1 + 0.12 * Math.sin(JulianDate.toDate(t ?? JulianDate.now()).getTime() / 220), false)
          : 1,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: ALWAYS_ON_TOP,
      },
    });
    if (!current || !show || incident.status === "contained") return;

    // Head arrow: from the ignition to the furthest cell burning along the head by now.
    const project = projector([incident.lat, incident.lon]);
    const theta = (current.head_bearing_deg * Math.PI) / 180;
    let best = 0;
    for (const [lat, lon, m] of current.cells) {
      if (m > minutes) continue;
      const [x, y] = project([lat, lon]);
      best = Math.max(best, x * Math.sin(theta) + y * Math.cos(theta));
    }
    if (best > 150) {
      const kLat = 1 / 111_320;
      const kLon = 1 / (111_320 * Math.cos((incident.lat * Math.PI) / 180));
      const tip: [number, number] = [incident.lat + best * Math.cos(theta) * kLat, incident.lon + best * Math.sin(theta) * kLon];
      ds.entities.add({
        id: "head-arrow",
        polyline: {
          positions: [Cartesian3.fromDegrees(incident.lon, incident.lat), Cartesian3.fromDegrees(tip[1], tip[0])],
          width: 16,
          clampToGround: true,
          classificationType: ClassificationType.BOTH,
          material: new PolylineArrowMaterialProperty(C.heat.withAlpha(0.9)),
        },
      });
    }
    for (const c of current.communities) {
      if (c.arrival_min === null) continue;
      const reached = c.arrival_min <= minutes;
      const tone = c.arrival_min <= 90 ? C.heat : c.arrival_min <= 180 ? C.warn : C.muted;
      ds.entities.add({
        id: `arrival:${c.name}`,
        position: toCartesian([c.lat, c.lon]),
        label: {
          text: reached ? "Fire has reached" : `Fire in ${formatMinutes(c.arrival_min - minutes)}`,
          font: MONO_FONT,
          fillColor: tone,
          outlineColor: C.void,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 8),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: ALWAYS_ON_TOP,
        },
      });
    }
  }, [ds, incident, current, minutes, show]);

  return null;
}
