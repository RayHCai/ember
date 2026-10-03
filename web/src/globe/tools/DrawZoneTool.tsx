import {
  CallbackProperty,
  ClassificationType,
  HeightReference,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  type Cartesian3,
} from "cesium";
import { useEffect, useRef } from "react";
import { isTypingTarget } from "../../hooks/useHotkeys";
import { useAppStore } from "../../state/store";
import type { LatLon } from "../../types/events";
import { ALWAYS_ON_TOP, C, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";
import { useGlobeInput } from "../useGlobeInput";

const VERTEX = "draw-vertex:";

function vertexIndex(id: string): number | null {
  return id.startsWith(VERTEX) ? Number(id.slice(VERTEX.length)) : null;
}

/**
 * Draw a zone outline: click to add points, click the first point or
 * double-click to close, then drag points to adjust. The panel names and saves it.
 */
export function DrawZoneTool() {
  const viewer = useAppStore((s) => s.viewer);
  const active = useAppStore((s) => s.tool?.kind === "draw-zone");
  const draft = useAppStore((s) => s.zoneDraft);
  const setDraft = useAppStore((s) => s.setZoneDraft);
  const ds = useDataSource(viewer, "draw-zone");
  const cursor = useRef<LatLon | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const update = (points: LatLon[], closed = draftRef.current?.closed ?? false) => setDraft({ points, closed });

  // Fill and edges read the draft through callbacks, so they follow every change.
  useEffect(() => {
    if (!ds || !active) return;
    const positions = (): Cartesian3[] => (draftRef.current?.points ?? []).map((p) => toCartesian(p));
    ds.entities.add({
      id: "draw-fill",
      polygon: {
        hierarchy: new CallbackProperty(() => {
          const pts = positions();
          return pts.length >= 3 ? new PolygonHierarchy(pts) : undefined;
        }, false),
        material: C.signal.withAlpha(0.14),
        classificationType: ClassificationType.BOTH,
      },
    });
    ds.entities.add({
      id: "draw-edges",
      polyline: {
        positions: new CallbackProperty(() => {
          const d = draftRef.current;
          const pts = positions();
          if (d?.closed && pts.length >= 3) return [...pts, pts[0]!];
          if (!d?.closed && cursor.current && pts.length > 0) return [...pts, toCartesian(cursor.current)];
          return pts;
        }, false),
        width: 2.5,
        clampToGround: true,
        classificationType: ClassificationType.BOTH,
        material: C.signal,
      },
    });
    ds.entities.add({
      id: "draw-closing",
      polyline: {
        positions: new CallbackProperty(() => {
          const d = draftRef.current;
          const pts = positions();
          if (!d || d.closed || pts.length < 2) return [];
          const end = cursor.current ? toCartesian(cursor.current) : pts[pts.length - 1]!;
          return [end, pts[0]!];
        }, false),
        width: 1.5,
        clampToGround: true,
        classificationType: ClassificationType.BOTH,
        material: new PolylineDashMaterialProperty({ color: C.signal.withAlpha(0.7), dashLength: 10 }),
      },
    });
    return () => ds.entities.removeAll();
  }, [ds, active]);

  // One draggable point per vertex. The first grows once the shape can close.
  useEffect(() => {
    if (!ds) return;
    const points = active ? (draft?.points ?? []) : [];
    const canClose = !draft?.closed && points.length >= 3;
    points.forEach((p, i) => {
      const id = `${VERTEX}${i}`;
      const position = toCartesian(p);
      const existing = ds.entities.getById(id);
      const size = i === 0 && canClose ? 14 : 9;
      if (existing?.point) {
        existing.position = position as never;
        existing.point.pixelSize = size as never;
      } else {
        ds.entities.add({
          id,
          position,
          point: {
            pixelSize: size,
            color: C.signal,
            outlineColor: C.void,
            outlineWidth: 2,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: ALWAYS_ON_TOP,
          },
        });
      }
    });
    for (const entity of [...ds.entities.values]) {
      const i = vertexIndex(entity.id);
      if (i !== null && i >= points.length) ds.entities.remove(entity);
    }
  }, [ds, active, draft]);

  useGlobeInput(viewer, active, {
    cursor: draft?.closed ? "" : "crosshair",
    onMove: (point) => {
      cursor.current = point ? [point.lat, point.lon] : null;
    },
    onClick: (point, entity) => {
      const d = draftRef.current;
      if (!d || d.closed || !point) return;
      const hit = entity ? vertexIndex(entity.id) : null;
      if (hit === 0 && d.points.length >= 3) return update(d.points, true);
      // A click on an existing point (including the second click of a double-click) adds nothing.
      if (hit !== null) return;
      update([...d.points, [point.lat, point.lon]]);
    },
    onDoubleClick: () => {
      const d = draftRef.current;
      if (d && !d.closed && d.points.length >= 3) update(d.points, true);
    },
    draggable: (entity) => vertexIndex(entity.id) !== null,
    onDrag: (entity, point) => {
      const i = vertexIndex(entity.id);
      const d = draftRef.current;
      if (i === null || !d) return;
      const points = d.points.slice();
      points[i] = [point.lat, point.lon];
      update(points);
    },
  });

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const d = draftRef.current;
      if (e.key === "Escape") {
        useAppStore.getState().setTool(null);
        setDraft(null);
      } else if ((e.key === "Backspace" || e.key === "Delete") && d && !d.closed) {
        update(d.points.slice(0, -1));
      } else if (e.key === "Enter" && d && !d.closed && d.points.length >= 3) {
        update(d.points, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return null;
}
