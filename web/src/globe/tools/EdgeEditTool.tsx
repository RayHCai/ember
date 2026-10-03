import { useAppStore } from "../../state/store";
import type { EdgeServer } from "../../types/events";
import { useGlobeInput } from "../useGlobeInput";

const PREFIX = "edge:";
const DEFAULT_RADIUS_M = 1500;

function serverId(entityId: string): string | null {
  return entityId.startsWith(PREFIX) ? entityId.slice(PREFIX.length) : null;
}

function nextId(servers: EdgeServer[]): string {
  const used = new Set(servers.map((s) => s.id));
  for (let n = servers.length + 1; ; n++) if (!used.has(`edge-${n}`)) return `edge-${n}`;
}

/** Drag servers to move them, click the map to add one, right-click to remove. */
export function EdgeEditTool() {
  const viewer = useAppStore((s) => s.viewer);
  const tool = useAppStore((s) => s.tool);
  const draft = useAppStore((s) => s.edgeDraft);
  const active = tool?.kind === "edit-edge" && draft?.zoneId === tool.zoneId;

  const write = (servers: EdgeServer[]) => {
    const current = useAppStore.getState().edgeDraft;
    if (current) useAppStore.getState().setEdgeDraft({ ...current, servers });
  };
  const servers = () => useAppStore.getState().edgeDraft?.servers ?? [];

  useGlobeInput(viewer, active, {
    cursor: "crosshair",
    onClick: (point, entity) => {
      if (!point || (entity && serverId(entity.id))) return;
      const list = servers();
      const radius = list[0]?.radius_m ?? DEFAULT_RADIUS_M;
      write([...list, { id: nextId(list), lat: point.lat, lon: point.lon, radius_m: radius, status: "pending" }]);
    },
    onRightClick: (entity) => {
      const id = entity && serverId(entity.id);
      if (id) write(servers().filter((s) => s.id !== id));
    },
    draggable: (entity) => serverId(entity.id) !== null,
    onDrag: (entity, point) => {
      const id = serverId(entity.id);
      write(servers().map((s) => (s.id === id ? { ...s, lat: point.lat, lon: point.lon, near_road: undefined } : s)));
    },
  });

  return null;
}
