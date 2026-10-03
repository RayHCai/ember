import { cx } from "../lib/format";
import { useAppStore } from "../state/store";
import hud from "./hud.module.css";
import styles from "./MapBadge.module.css";

/** Names the active map, and says plainly when a fallback is in use. */
export function MapBadge() {
  const map = useAppStore((s) => s.mapSource);
  if (!map) {
    return (
      <div className={cx(hud.panel, styles.badge)} data-testid="map-badge">
        <span className={hud.label}>Map</span>
        <span>Loading</span>
      </div>
    );
  }
  return (
    <div className={cx(hud.panel, styles.badge)} data-testid="map-badge" data-map={map.id}>
      <span className={hud.label}>{map.fallbackReason ? "Fallback map" : "Map"}</span>
      <span>{map.label}</span>
      {map.fallbackReason && <span className={styles.reason}>{map.fallbackReason}</span>}
    </div>
  );
}
