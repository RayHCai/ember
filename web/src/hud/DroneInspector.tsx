import { cx, formatLat, formatLon } from "../lib/format";
import { useTelemetry } from "../state/telemetry";
import type { DroneState } from "../types/events";
import hud from "./hud.module.css";
import styles from "./DroneInspector.module.css";

const STATE_LABEL: Record<DroneState, string> = {
  docked: "Docked, ready",
  charging: "Charging on dock",
  transit: "Flying to survey line",
  surveying: "Surveying",
  returning: "Returning to dock",
  verifying: "Verifying a hotspot",
  suppressing: "Suppressing fire",
};

const DANGER: Partial<Record<DroneState, string>> = { verifying: "warn", suppressing: "heat" };

export function DroneInspector() {
  const drone = useTelemetry((s) => (s.selectedId ? (s.drones[s.selectedId] ?? null) : null));
  const close = () => useTelemetry.getState().select(null);
  if (!drone) return null;

  const battery = Math.round(drone.battery_pct);
  const low = battery < 25;
  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Drone inspector" data-testid="drone-inspector">
      <div className={hud.header}>
        <h2 className={hud.title}>
          {drone.id} <span className={hud.simTag}>SIM</span>
        </h2>
        <button type="button" className={styles.close} onClick={close}>
          Close
        </button>
      </div>
      <dl className={styles.grid}>
        <dt className={hud.label}>State</dt>
        <dd className={cx(styles.state, DANGER[drone.state] && styles[DANGER[drone.state]!])}>{STATE_LABEL[drone.state]}</dd>
        <dt className={hud.label}>Battery</dt>
        <dd className={styles.battery}>
          <span className={styles.bar}>
            <span className={cx(styles.fill, low && styles.low)} style={{ width: `${battery}%` }} />
          </span>
          <span className={hud.mono}>{battery}%</span>
        </dd>
        <dt className={hud.label}>Sortie</dt>
        <dd className={hud.mono}>
          {drone.sortie ? `${drone.sortie.number} of ${drone.sortie.total}, ${Math.round(drone.sortie.progress_pct)}% flown` : "None"}
        </dd>
        <dt className={hud.label}>Dock</dt>
        <dd className={hud.mono}>{drone.dock_id}</dd>
        <dt className={hud.label}>Altitude</dt>
        <dd className={hud.mono}>{Math.round(drone.alt_m)} m above ground</dd>
        <dt className={hud.label}>Heading</dt>
        <dd className={hud.mono}>{Math.round(drone.heading_deg)}°</dd>
        <dt className={hud.label}>Position</dt>
        <dd className={hud.mono}>
          {formatLat(drone.lat)} {formatLon(drone.lon)}
        </dd>
      </dl>
    </section>
  );
}
