import { startTestFire } from "../../data/actions";
import { useAppStore } from "../../state/store";
import { pushToast } from "../../state/toasts";
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

  useGlobeInput(viewer, active, {
    cursor: "crosshair",
    onClick: (point) => {
      if (point) useAppStore.getState().setPhonePreviewAt([point.lat, point.lon]);
    },
  });
  return null;
}
