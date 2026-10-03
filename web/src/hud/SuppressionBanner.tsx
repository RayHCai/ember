import { selectActiveIncident, useAppStore } from "../state/store";
import hud from "./hud.module.css";
import styles from "./SuppressionBanner.module.css";

/** Always on screen while a suppression mission runs: the mission is simulated. */
export function SuppressionBanner() {
  const incident = useAppStore(selectActiveIncident);
  const active = useAppStore((s) => (incident ? Boolean(s.suppression[incident.id]) : false));
  if (!incident || !active || incident.status === "contained") return null;
  return (
    <div className={`${hud.panel} ${styles.banner}`} role="status" data-testid="suppression-banner">
      <span className={hud.simTag}>SIM</span>
      Simulated suppression. In a real deployment, suppression is done by partner crews or partner drones.
    </div>
  );
}
