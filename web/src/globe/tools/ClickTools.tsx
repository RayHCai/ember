import { HeightReference } from "cesium";
import { useEffect } from "react";
import { startTestFire } from "../../data/actions";
import { useAppStore } from "../../state/store";
import { pushToast } from "../../state/toasts";
import { ALWAYS_ON_TOP, C, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";
import { useGlobeInput } from "../useGlobeInput";

/** "Start test fire": the next click on the map starts a simulated fire there. */
export function TestFireTool() {
  const viewer = useAppStore((s) => s.viewer);
  const tool = useAppStore((s) => s.tool);
  const active = tool?.kind === "test-fire";

  useGlobeInput(viewer, active, {
    cursor: "crosshair",
    onClick: (point) => {
      const current = useAppStore.getState().tool;
      if (!point || current?.kind !== "test-fire") return;
      useAppStore.getState().setTool(null);
      void startTestFire(current.zoneId, [point.lat, point.lon]).then((ok) => {
        if (!ok) pushToast("Click inside the watch zone to start a test fire.", "error");
      });
    },
  });
  return null;
}

/** "Phone preview": click anywhere to see what a resident there would receive. */
export function PhonePreviewTool() {
  const viewer = useAppStore((s) => s.viewer);
  const active = useAppStore((s) => s.tool?.kind === "phone-preview");
  const at = useAppStore((s) => s.phonePreviewAt);
  const ds = useDataSource(viewer, "phone-pin");

  useEffect(() => {
    if (!ds) return;
    ds.entities.removeAll();
    if (!active || !at) return;
    ds.entities.add({
      position: toCartesian(at),
      point: {
        pixelSize: 12,
        color: C.text,
        outlineColor: C.signal,
        outlineWidth: 3,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: ALWAYS_ON_TOP,
      },
    });
  }, [ds, active, at]);

  useGlobeInput(viewer, active, {
    cursor: "crosshair",
    onClick: (point) => {
      if (point) useAppStore.getState().setPhonePreviewAt([point.lat, point.lon]);
    },
  });
  return null;
}
