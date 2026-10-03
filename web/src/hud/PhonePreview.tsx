import { projector } from "../geo/grid";
import { cx, formatClock } from "../lib/format";
import { selectActiveIncident, useAppStore } from "../state/store";
import type { Resident, Tier } from "../types/events";
import hud from "./hud.module.css";
import styles from "./PhonePreview.module.css";

const TIER_LABEL: Record<Tier, string> = { evacuate: "Evacuate", prepare: "Prepare", watch: "Watch" };
const NEAR_M = 2000;

/** What a resident at the clicked spot would receive: the nearest resident's tier and message. */
export function PhonePreview() {
  const active = useAppStore((s) => s.tool?.kind === "phone-preview");
  const at = useAppStore((s) => s.phonePreviewAt);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const recipients = useAppStore((s) => (zoneId ? s.recipients[zoneId] : undefined));
  const incident = useAppStore(selectActiveIncident);
  const notifications = useAppStore((s) => s.notifications);
  const routes = useAppStore((s) => (zoneId ? s.routes[zoneId] : undefined));
  if (!active) return null;

  let body: React.ReactNode;
  if (!at) {
    body = <p className={styles.hint}>Click anywhere on the map to see what a resident there would receive.</p>;
  } else if (!recipients || !incident) {
    body = <p className={styles.hint}>No alerts have gone out yet. Phone previews show alerts for an active fire.</p>;
  } else {
    const project = projector(at);
    let nearest: Resident | null = null;
    let best = Infinity;
    for (const r of recipients.residents) {
      const [x, y] = project([r.lat, r.lon]);
      const d = Math.hypot(x, y);
      if (d < best) {
        best = d;
        nearest = r;
      }
    }
    const tier = nearest && best <= NEAR_M ? nearest.tier : null;
    const note = tier
      ? [...notifications].reverse().find((n) => n.tier === tier && (!n.incident_id || n.incident_id === incident.id))
      : undefined;
    const route = note?.route_id && routes ? routes[note.route_id] : undefined;
    if (!tier || !note) {
      body = (
        <p className={styles.hint}>
          No alert for this spot. {nearest && best <= NEAR_M ? "Residents here are outside every alert tier." : "No residents within 2 km."}
        </p>
      );
    } else {
      body = (
        <div className={styles.message} data-testid="phone-message">
          <div className={styles.appRow}>
            <span className={styles.app}>Ember alert</span>
            <span className={hud.mono}>{note.ts ? formatClock(note.ts) : ""}</span>
          </div>
          <span className={cx(styles.tier, styles[tier])}>{TIER_LABEL[tier]}</span>
          <p className={styles.text}>{note.text}</p>
          {route && (
            <p className={styles.detail}>
              Route: {route.community} to {route.shelter}, {route.distance_km.toFixed(1)} km, about {route.eta_min} min.
            </p>
          )}
          {note.shelter && !route && <p className={styles.detail}>Shelter: {note.shelter}</p>}
          {note.audio_url ? (
            <audio controls src={note.audio_url} className={styles.audio} />
          ) : (
            <p className={styles.detail}>Audio: not available (ElevenLabs is not connected).</p>
          )}
          <p className={styles.footer}>Resident near {nearest?.community} (SIM)</p>
        </div>
      );
    }
  }

  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Phone preview" data-testid="phone-preview">
      <div className={hud.header}>
        <h2 className={hud.title}>
          Phone preview <span className={hud.simTag}>SIM</span>
        </h2>
        <button
          type="button"
          className={styles.close}
          onClick={() => {
            useAppStore.getState().setTool(null);
            useAppStore.getState().setPhonePreviewAt(null);
          }}
        >
          Close
        </button>
      </div>
      <div className={styles.phone}>
        <div className={styles.notch} />
        {body}
      </div>
    </section>
  );
}
