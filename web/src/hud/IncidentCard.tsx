import { useEffect, useRef, useState } from "react";
import { dispatchDrones } from "../data/actions";
import { flyToPoint, prefersReducedMotion } from "../globe/camera";
import { cx, formatLat, formatLon } from "../lib/format";
import { compass, formatMinutes } from "../lib/time";
import { selectActiveIncident, useAppStore } from "../state/store";
import hud from "./hud.module.css";
import styles from "./IncidentCard.module.css";

const STATUS = {
  suspected: { label: "Possible fire", tone: "warn" },
  confirmed: { label: "Fire confirmed", tone: "heat" },
  contained: { label: "Contained", tone: "quiet" },
  dismissed: { label: "Dismissed", tone: "quiet" },
} as const;

const PLAY_MS = 8000;

function ContainmentRing({ pct }: { pct: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg className={styles.ring} viewBox="0 0 40 40" aria-hidden>
      <circle cx="20" cy="20" r={r} className={styles.ringTrack} />
      <circle
        cx="20"
        cy="20"
        r={r}
        className={styles.ringFill}
        strokeDasharray={`${(c * pct) / 100} ${c}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  );
}

function Scrubber({ horizon, incidentId }: { horizon: number; incidentId: string }) {
  const minutes = useAppStore((s) => s.spreadMinutes);
  const setMinutes = useAppStore((s) => s.setSpreadMinutes);
  const [playing, setPlaying] = useState(false);
  const frame = useRef(0);

  const play = (from = 0) => {
    cancelAnimationFrame(frame.current);
    if (prefersReducedMotion()) {
      setMinutes(horizon);
      return;
    }
    const start = performance.now();
    setPlaying(true);
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / PLAY_MS);
      setMinutes(Math.round(from + (horizon - from) * t));
      if (t < 1) frame.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    step();
  };

  // A new incident's spread plays once from now to the horizon. (No "already
  // played" guard: React runs effects twice in development, and a guard would
  // leave the cancelled first run stuck.)
  useEffect(() => {
    play(0);
    return () => {
      cancelAnimationFrame(frame.current);
      setPlaying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  return (
    <div className={styles.scrubber}>
      <button
        type="button"
        className={cx(hud.button, styles.small)}
        onClick={() => {
          if (playing) {
            cancelAnimationFrame(frame.current);
            setPlaying(false);
          } else play(minutes >= horizon ? 0 : minutes);
        }}
      >
        {playing ? "Stop" : "Play spread"}
      </button>
      <input
        type="range"
        min={0}
        max={horizon}
        step={5}
        value={Math.min(minutes, horizon)}
        aria-label="Predicted spread time"
        className={styles.range}
        onChange={(e) => {
          cancelAnimationFrame(frame.current);
          setPlaying(false);
          setMinutes(Number(e.target.value));
        }}
      />
      <span className={cx(hud.mono, styles.when)} data-testid="spread-time">
        {minutes <= 0 ? "Now" : `+${formatMinutes(minutes)}`}
      </span>
    </div>
  );
}

export function IncidentCard() {
  const incident = useAppStore(selectActiveIncident);
  const spread = useAppStore((s) => (s.activeZoneId ? s.spread[s.activeZoneId] : undefined));
  const suppression = useAppStore((s) => (incident ? s.suppression[incident.id] : undefined));
  const previewing = useAppStore((s) => s.tool?.kind === "phone-preview");
  if (!incident) return null;

  const status = STATUS[incident.status];
  const current = spread?.incident_id === incident.id ? spread : undefined;
  const next = current?.communities
    .filter((c) => c.arrival_min !== null)
    .sort((a, b) => a.arrival_min! - b.arrival_min!)[0];

  const flyTo = () => {
    const viewer = useAppStore.getState().viewer;
    if (viewer) void flyToPoint(viewer, incident.lat, incident.lon, { range: 9000, pitchDeg: -40, duration: 2 });
  };
  const togglePreview = () => {
    const s = useAppStore.getState();
    s.setPhonePreviewAt(null);
    s.setTool(previewing ? null : { kind: "phone-preview" });
  };

  return (
    <section className={cx(hud.panel, styles.card, styles[status.tone])} aria-label="Incident" data-testid="incident-card">
      <div className={styles.head}>
        <span className={cx(styles.status, styles[`text_${status.tone}`])}>{status.label}</span>
        <span className={hud.simTag}>SIM</span>
        <span className={styles.facts}>
          <span>
            Confidence <span className={hud.mono}>{incident.confidence.toFixed(2)}</span>
          </span>
          <span className={hud.mono}>
            {formatLat(incident.lat)} {formatLon(incident.lon)}
          </span>
          {current && incident.status !== "contained" && <span>Head runs {compass(current.head_bearing_deg)}</span>}
          {next && incident.status !== "contained" && (
            <span className={next.arrival_min! <= 180 ? styles.text_heat : undefined}>
              Reaches {next.name} in <span className={hud.mono}>{formatMinutes(next.arrival_min!)}</span>
            </span>
          )}
        </span>
      </div>
      {suppression && (
        <div className={styles.containment} data-testid="containment">
          <ContainmentRing pct={suppression.containment_pct} />
          <span>
            Containment <span className={hud.mono}>{Math.round(suppression.containment_pct)}%</span>
          </span>
          <span className={hud.muted}>
            {suppression.sorties_done} of {suppression.sorties_planned} sorties
          </span>
          <span className={hud.simTag}>SIM</span>
        </div>
      )}
      {current && incident.status !== "contained" && <Scrubber horizon={current.horizon_min} incidentId={incident.id} />}
      <div className={styles.actions}>
        <button type="button" className={cx(hud.button, styles.small)} onClick={flyTo}>
          Fly to fire
        </button>
        {incident.status === "confirmed" && !suppression && (
          <button type="button" className={cx(hud.button, hud.danger, styles.small)} onClick={() => void dispatchDrones(incident.id)}>
            Dispatch drones
          </button>
        )}
        <button type="button" className={cx(hud.button, styles.small, previewing && hud.primary)} onClick={togglePreview}>
          {previewing ? "Close phone preview" : "Phone preview"}
        </button>
      </div>
    </section>
  );
}
