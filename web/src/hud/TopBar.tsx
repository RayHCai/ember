import { useEffect, useState } from "react";
import { cx, formatSimTime } from "../lib/format";
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

function ZoneStatus() {
  const zone = useAppStore(selectActiveZone);
  const text = useAppStore((s) => zoneStatus(s).text);
  const tone = useAppStore((s) => zoneStatus(s).tone);
  return (
    <div className={styles.zone}>
      <span className={styles.zoneName}>{zone?.name ?? "No zone"}</span>
      <span className={cx(styles.zoneStatus, styles[tone])}>{text}</span>
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
    <div className={styles.clock}>
      <span className={hud.label}>Sim time</span>
      <span className={cx(hud.mono, styles.clockTime)} data-testid="sim-time">
        {sim ? formatSimTime(simNow(sim)) : "--"}
      </span>
      <span className={cx(hud.mono, styles.speed)}>
        {sim ? (sim.paused ? "Paused" : `${sim.speed}x`) : ""}
      </span>
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
    <header className={cx(hud.panel, styles.bar)}>
      <div className={styles.left}>
        <span className={styles.product}>EMBER</span>
        <span className={styles.rule} />
        <ZoneStatus />
      </div>
      <SimClockDisplay />
      <div className={styles.right}>
        <Connection />
        <FilterSwitch />
      </div>
    </header>
  );
}
