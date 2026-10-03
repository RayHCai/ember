import { useAppStore } from "../../state/store";
import type { Shelter } from "../../types/events";
import { useGlobeInput } from "../useGlobeInput";

const PREFIX = "shelter:";

function shelterId(entityId: string): string | null {
  return entityId.startsWith(PREFIX) ? entityId.slice(PREFIX.length) : null;
}

/** Drag shelters to move them, click the map to add one, right-click to remove. */
export function ShelterEditTool() {
  const viewer = useAppStore((s) => s.viewer);
  const tool = useAppStore((s) => s.tool);
  const draft = useAppStore((s) => s.shelterDraft);
  const active = tool?.kind === "edit-shelters" && draft?.zoneId === tool.zoneId;

  const shelters = () => useAppStore.getState().shelterDraft?.shelters ?? [];
  const write = (next: Shelter[]) => {
    const current = useAppStore.getState().shelterDraft;
    if (current) useAppStore.getState().setShelterDraft({ ...current, shelters: next });
  };

  useGlobeInput(viewer, active, {
    cursor: "crosshair",
    onClick: (point, entity) => {
      if (!point || (entity && shelterId(entity.id))) return;
      const list = shelters();
      const id = `new-${Date.now().toString(36)}`;
      write([...list, { id, name: `Shelter ${list.length + 1}`, lat: point.lat, lon: point.lon, kind: "operator" }]);
    },
    onRightClick: (entity) => {
      const id = entity && shelterId(entity.id);
      if (id) write(shelters().filter((s) => s.id !== id));
    },
    draggable: (entity) => shelterId(entity.id) !== null,
    onDrag: (entity, point) => {
      const id = shelterId(entity.id);
      write(shelters().map((s) => (s.id === id ? { ...s, lat: point.lat, lon: point.lon } : s)));
    },
  });

  return null;
}
