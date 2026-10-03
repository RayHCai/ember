import { cx, formatClock } from "../lib/format";
import { useAppStore, type AgentTab } from "../state/store";
import type { EmberEvent } from "../types/events";
import hud from "./hud.module.css";
import styles from "./AgentPanel.module.css";

const TABS: { id: AgentTab; label: string }[] = [
  { id: "log", label: "Log" },
  { id: "approvals", label: "Approvals" },
  { id: "chat", label: "Chat" },
];

/** One readable line for an agent event, whatever its payload shape. */
export function describeEvent(event: EmberEvent): string {
  const p = event.payload as Record<string, unknown>;
  for (const key of ["message", "summary", "text", "reason"]) {
    const value = p[key];
    if (typeof value === "string" && value) return value;
  }
  return event.kind.replace(/_/g, " ");
}

function LogTab() {
  const log = useAppStore((s) => s.log);
  if (log.length === 0) {
    return (
      <div className={hud.empty}>
        <strong>No agent activity yet</strong>
        Draw a watch zone and deploy edge servers. The agent logs every step it takes here.
      </div>
    );
  }
  return (
    <ol className={cx(styles.log, hud.scroll)}>
      {log
        .slice()
        .reverse()
        .map((event, i) => (
          <li key={`${event.ts}-${i}`} className={styles.entry}>
            <span className={cx(hud.mono, hud.muted)}>{formatClock(event.ts)}</span>
            <span className={styles.kind}>{event.kind.replace(/_/g, " ")}</span>
            <span className={styles.text}>{describeEvent(event)}</span>
          </li>
        ))}
    </ol>
  );
}

function ApprovalsTab() {
  const approvals = useAppStore((s) => s.approvals);
  const pending = Object.values(approvals);
  if (pending.length === 0) {
    return (
      <div className={hud.empty}>
        <strong>Nothing waiting for approval</strong>
        Alerts the agent cannot send on its own, such as a fire not yet confirmed by a drone, wait
        here for you.
      </div>
    );
  }
  return (
    <ol className={cx(styles.log, hud.scroll)}>
      {pending.map((event, i) => (
        <li key={`${event.ts}-${i}`} className={styles.entry}>
          <span className={cx(hud.mono, hud.muted)}>{formatClock(event.ts)}</span>
          <span className={styles.kind}>approval</span>
          <span className={styles.text}>{describeEvent(event)}</span>
        </li>
      ))}
    </ol>
  );
}

function ChatTab() {
  return (
    <div className={styles.chat}>
      <div className={hud.empty}>
        <strong>Talk to the agent</strong>
        Ask for the zone status, approve alerts, or report a fire, for example "fire near Altadena".
      </div>
      <form className={styles.chatForm} onSubmit={(e) => e.preventDefault()}>
        <input
          className={cx(hud.input, styles.chatInput)}
          placeholder="Chat connects when the server is live"
          disabled
        />
      </form>
    </div>
  );
}

export function AgentPanel() {
  const tab = useAppStore((s) => s.agentTab);
  const setTab = useAppStore((s) => s.setAgentTab);
  const pendingCount = useAppStore((s) => Object.keys(s.approvals).length);

  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Agent">
      <div className={hud.header}>
        <h2 className={hud.title}>Agent</h2>
      </div>
      <div className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cx(styles.tab, tab === t.id && styles.tabOn)}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "approvals" && pendingCount > 0 && (
              <span className={styles.count}>{pendingCount}</span>
            )}
          </button>
        ))}
      </div>
      <div className={styles.body}>
        {tab === "log" && <LogTab />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "chat" && <ChatTab />}
      </div>
    </section>
  );
}
