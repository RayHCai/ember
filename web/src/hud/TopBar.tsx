import { useEffect, useState } from "react";
import { config } from "../config";
import { attempt, request } from "../data/api";
import { cx, formatDuration, formatSimTime } from "../lib/format";
import {
  FILTERS,
  selectActiveZone,
  simNow,
  useAppStore,
  type AppState,
  type ConnectionState,
} from "../state/store";
import hud from "./hud.module.css";
import styles from "./TopBar.module.css";

type ZoneTone = "quiet" | "warn" | "heat";

function zoneStatus(s: AppState): { text: string; tone: ZoneTone } {
  const zone = selectActiveZone(s);
  if (!zone) return { text: "No watch zone yet", tone: "quiet" };
  const incidents = Object.values(s.incidents).filter((i) => i.zone_id === zone.id);
  if (incidents.some((i) => i.status === "confirmed")) return { text: "Fire confirmed", tone: "heat" };
  if (incidents.some((i) => i.status === "suspected")) return { text: "Checking a hotspot", tone: "warn" };
  if (s.surveys[zone.id]?.status === "running") return { text: "Survey running", tone: "quiet" };
  const plan = s.edgePlans[zone.id];
  if (plan?.servers.some((srv) => srv.status === "deployed")) return { text: "Watching", tone: "quiet" };
  return { text: "Setting up", tone: "quiet" };
}

function SurveyStatus({ zoneId }: { zoneId: string }) {
  const survey = useAppStore((s) => s.surveys[zoneId]);
  const sim = useAppStore((s) => s.sim);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!survey) return null;
  if (survey.status === "running") {
    const pct = Math.round(survey.progress_pct);
    return (
      <span className={styles.survey} data-testid="survey-progress">
        <span className={styles.progress}>
          <span className={styles.progressFill} style={{ width: `${pct}%` }} />
        </span>
        <span className={hud.mono}>{pct}%</span>
      </span>
    );
  }
  if (survey.next_at && sim) {
    const left = Date.parse(survey.next_at) - simNow(sim);
    return (
      <span className={styles.survey} data-testid="survey-next">
        Next survey in <span className={hud.mono}>{formatDuration(left)}</span>
      </span>
    );
  }
  return null;
}

function ZoneStatus() {
  const zone = useAppStore(selectActiveZone);
  const text = useAppStore((s) => zoneStatus(s).text);
  const tone = useAppStore((s) => zoneStatus(s).tone);
  return (
    <div className={styles.zone}>
      <span className={styles.zoneName}>{zone?.name ?? "No zone"}</span>
      <span className={styles.statusLine}>
        <span className={cx(styles.zoneStatus, styles[tone])}>{text}</span>
        {zone && <SurveyStatus zoneId={zone.id} />}
      </span>
    </div>
  );
}

function SimClockDisplay() {
  const sim = useAppStore((s) => s.sim);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!sim || sim.paused) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [sim]);

  return (
    <div className={styles.clock} data-tauri-drag-region>
      <span className={hud.label}>Sim time</span>
      <span className={cx(hud.mono, styles.clockTime)} data-testid="sim-time">
        {sim ? formatSimTime(simNow(sim)) : "--"}
      </span>
      <SpeedControls />
    </div>
  );
}

const SPEEDS = [1, 60, 360];

function SpeedControls() {
  const speed = useAppStore((s) => s.sim?.speed);
  const paused = useAppStore((s) => s.sim?.paused ?? false);
  const hasClock = useAppStore((s) => s.sim !== null);

  const setSpeed = (next: number) => {
    if (config.useMock) useAppStore.getState().setSimLocal({ speed: next, paused: false });
    else void attempt("Changing sim speed", () => request("/sim/speed", { method: "POST", json: { speed: next } }));
  };
  const togglePause = () => {
    if (config.useMock) useAppStore.getState().setSimLocal({ paused: !paused });
    else void attempt(paused ? "Resuming" : "Pausing", () => request(paused ? "/sim/resume" : "/sim/pause", { method: "POST" }));
  };

  return (
    <div className={styles.speeds} role="group" aria-label="Sim speed">
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          className={cx(styles.speedButton, speed === s && !paused && styles.speedOn)}
          aria-pressed={speed === s && !paused}
          disabled={!hasClock}
          onClick={() => setSpeed(s)}
        >
          {s}x
        </button>
      ))}
      <button
        type="button"
        className={cx(styles.speedButton, paused && styles.speedOn)}
        aria-pressed={paused}
        disabled={!hasClock}
        onClick={togglePause}
      >
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  mock: "Mock stream",
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
};

function Connection() {
  const connection = useAppStore((s) => s.connection);
  return (
    <div className={styles.connection} title={`Event stream: ${CONNECTION_LABEL[connection]}`}>
      <span className={cx(styles.dot, styles[`dot_${connection}`])} />
      <span className={hud.label}>{CONNECTION_LABEL[connection]}</span>
      {connection === "mock" && <span className={hud.simTag}>SIM</span>}
    </div>
  );
}

function FilterSwitch() {
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  return (
    <div className={styles.filters} role="group" aria-label="Map filter">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          className={cx(styles.filter, filter === f.id && styles.filterOn)}
          aria-pressed={filter === f.id}
          onClick={() => setFilter(f.id)}
          title={`${f.label} (key ${f.key})`}
        >
          <span className={styles.key}>{f.key}</span>
          {f.label}
        </button>
      ))}
    </div>
  );
}

export function TopBar() {
  return (
    // In the desktop app the top bar doubles as the window's title bar.
    <header className={cx(hud.panel, styles.bar)} data-tauri-drag-region>
      <div className={styles.left} data-tauri-drag-region>
        <span className={styles.product}>EMBER</span>
        <span className={styles.rule} />
        <ZoneStatus />
      </div>
      <SimClockDisplay />
      <div className={styles.right} data-tauri-drag-region>
        <Connection />
        <FilterSwitch />
      </div>
    </header>
  );
}
