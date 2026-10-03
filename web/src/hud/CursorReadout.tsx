import { ScreenSpaceEventHandler, ScreenSpaceEventType, type Cartesian2 } from "cesium";
import { forward } from "mgrs";
import { useEffect, useRef } from "react";
import { pickPoint } from "../globe/pick";
import { cx, formatAltitude, formatLat, formatLon } from "../lib/format";
import { useAppStore } from "../state/store";
import hud from "./hud.module.css";
import styles from "./CursorReadout.module.css";

function toMgrs(lat: number, lon: number): string {
  try {
    return forward([lon, lat], 5);
  } catch {
    return "Outside MGRS range";
  }
}

/**
 * Cursor position and camera altitude. Updates write straight to the DOM on
 * animation frames, so moving the mouse never re-renders React.
 */
export function CursorReadout() {
  const viewer = useAppStore((s) => s.viewer);
  const latRef = useRef<HTMLSpanElement>(null);
  const lonRef = useRef<HTMLSpanElement>(null);
  const mgrsRef = useRef<HTMLSpanElement>(null);
  const altRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!viewer) return;
    let frame = 0;
    let pending: Cartesian2 | null = null;

    const setText = (ref: React.RefObject<HTMLSpanElement | null>, text: string) => {
      if (ref.current) ref.current.textContent = text;
    };

    const update = () => {
      frame = 0;
      if (viewer.isDestroyed()) return;
      setText(altRef, formatAltitude(viewer.camera.positionCartographic.height));
      if (!pending) return;
      const point = pickPoint(viewer, pending);
      pending = null;
      if (!point) {
        setText(latRef, "--");
        setText(lonRef, "--");
        setText(mgrsRef, "--");
        return;
      }
      setText(latRef, formatLat(point.lat));
      setText(lonRef, formatLon(point.lon));
      setText(mgrsRef, toMgrs(point.lat, point.lon));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((move: ScreenSpaceEventHandler.MotionEvent) => {
      pending = move.endPosition.clone();
      schedule();
    }, ScreenSpaceEventType.MOUSE_MOVE);
    viewer.camera.percentageChanged = 0.01;
    const removeCameraListener = viewer.camera.changed.addEventListener(schedule);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      removeCameraListener();
      if (!handler.isDestroyed()) handler.destroy();
    };
  }, [viewer]);

  return (
    <div className={cx(hud.panel, styles.readout)} aria-label="Cursor position">
      <span className={hud.label}>Lat</span>
      <span ref={latRef} className={hud.mono}>--</span>
      <span className={hud.label}>Lon</span>
      <span ref={lonRef} className={hud.mono}>--</span>
      <span className={hud.label}>MGRS</span>
      <span ref={mgrsRef} className={hud.mono}>--</span>
      <span className={hud.label}>Camera</span>
      <span ref={altRef} className={hud.mono}>--</span>
    </div>
  );
}
