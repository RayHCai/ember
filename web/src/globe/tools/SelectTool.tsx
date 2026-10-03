import { useAppStore } from "../../state/store";
import { useTelemetry } from "../../state/telemetry";
import { useGlobeInput } from "../useGlobeInput";

/** With no editing tool active, clicking a drone opens its inspector. */
export function SelectTool() {
  const viewer = useAppStore((s) => s.viewer);
  const idle = useAppStore((s) => s.tool === null);

  useGlobeInput(viewer, idle, {
    onClick: (_point, entity) => {
      const id = entity?.id ?? "";
      if (id.startsWith("drone:")) useTelemetry.getState().select(id.slice("drone:".length));
      else if (!id) useTelemetry.getState().select(null);
    },
  });

  return null;
}
