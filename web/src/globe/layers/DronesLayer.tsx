import {
  Cartesian3,
  ConstantPositionProperty,
  HeightReference,
  Math as CesiumMath,
  type Color,
  type CustomDataSource,
} from "cesium";
import { useEffect } from "react";
import { useAppStore } from "../../state/store";
import { useTelemetry } from "../../state/telemetry";
import type { Drone, DroneState } from "../../types/events";
import { ALWAYS_ON_TOP, C, DRONE_ICON } from "../style";
import { useDataSource } from "../useDataSource";

const TRAIL_LENGTH = 10;
const TRAIL_SAMPLE_MS = 600;

// Warn and heat mean danger: only drones checking or fighting a fire use them.
export const DRONE_STATE_COLOR: Record<DroneState, Color> = {
  docked: C.muted,
  charging: C.muted,
  transit: C.signal,
  surveying: C.signal,
  returning: C.signal.withAlpha(0.8),
  verifying: C.warn,
  suppressing: C.heat,
};

export function isAirborne(state: DroneState): boolean {
  return state !== "docked" && state !== "charging";
}

interface Trail {
  points: Cartesian3[];
  lastSample: number;
}

function render(ds: CustomDataSource, drones: Record<string, Drone>, trails: Map<string, Trail>) {
  const now = performance.now();
  const seen = new Set<string>();
  for (const d of Object.values(drones)) {
    seen.add(d.id);
    const id = `drone:${d.id}`;
    const position = Cartesian3.fromDegrees(d.lon, d.lat, d.alt_m);
    const color = DRONE_STATE_COLOR[d.state] ?? C.signal;
    const rotation = -CesiumMath.toRadians(d.heading_deg);
    const airborne = isAirborne(d.state);
    let entity = ds.entities.getById(id);
    if (!entity) {
      entity = ds.entities.add({
        id,
        position: new ConstantPositionProperty(position),
        billboard: {
          image: DRONE_ICON,
          width: 22,
          height: 22,
          color,
          rotation,
          alignedAxis: Cartesian3.UNIT_Z,
          heightReference: HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: ALWAYS_ON_TOP,
        },
      });
    } else {
      (entity.position as ConstantPositionProperty).setValue(position);
      entity.billboard!.color = color as never;
      entity.billboard!.rotation = rotation as never;
    }
    // Drones resting on a dock are summarised by the dock's label instead.
    entity.show = airborne;

    let trail = trails.get(d.id);
    if (!trail) trails.set(d.id, (trail = { points: [], lastSample: 0 }));
    if (!airborne) trail.points = [];
    else if (now - trail.lastSample > TRAIL_SAMPLE_MS) {
      trail.points = [position, ...trail.points].slice(0, TRAIL_LENGTH);
      trail.lastSample = now;
    }
    for (let k = 0; k < TRAIL_LENGTH; k++) {
      const dotId = `trail:${d.id}:${k}`;
      const point = trail.points[k];
      let dot = ds.entities.getById(dotId);
      if (!dot) {
        dot = ds.entities.add({
          id: dotId,
          position: new ConstantPositionProperty(point ?? position),
          point: {
            pixelSize: 5 - k * 0.3,
            color: color.withAlpha(0.55 * (1 - k / TRAIL_LENGTH)),
            heightReference: HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: ALWAYS_ON_TOP,
          },
        });
      }
      dot.show = Boolean(point) && k > 0;
      if (point) {
        (dot.position as ConstantPositionProperty).setValue(point);
        dot.point!.color = color.withAlpha(0.55 * (1 - k / TRAIL_LENGTH)) as never;
      }
    }
  }
  for (const entity of [...ds.entities.values]) {
    const droneId = entity.id.split(":")[1];
    if (droneId && !seen.has(droneId)) ds.entities.remove(entity);
  }
}

/** Simulated drones with heading and short fading trails. */
export function DronesLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const show = useAppStore((s) => s.layers.drones);
  const ds = useDataSource(viewer, "drones");

  useEffect(() => {
    if (ds) ds.show = show;
  }, [ds, show]);

  useEffect(() => {
    if (!ds) return;
    const trails = new Map<string, Trail>();
    let frame = 0;
    const draw = () => {
      frame = 0;
      render(ds, useTelemetry.getState().drones, trails);
    };
    draw();
    // Telemetry bypasses React: redraw at most once per animation frame.
    const unsubscribe = useTelemetry.subscribe((s, prev) => {
      if (s.drones !== prev.drones && !frame) frame = requestAnimationFrame(draw);
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      ds.entities.removeAll();
    };
  }, [ds]);

  return null;
}
