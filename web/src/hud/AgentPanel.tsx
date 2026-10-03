import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { approveAlert, holdAlert, sendChat } from "../data/actions";
import { cx, formatClock } from "../lib/format";
import { useAppStore, type AgentTab } from "../state/store";
import type { AgentLog, AgentMode, ApprovalRequest, Decision, EmberEvent, Tier } from "../types/events";
import { useVoice } from "./useVoice";
import hud from "./hud.module.css";
import styles from "./AgentPanel.module.css";

const TABS: { id: AgentTab; label: string }[] = [
  { id: "log", label: "Log" },
  { id: "approvals", label: "Approvals" },
  { id: "chat", label: "Chat" },
];

const MODE_LABEL: Record<AgentMode, string> = {
  asi1: "ASI:One",
  fallback: "Fallback pipeline",
  policy: "Policy backstop",
};

const TIER_LABEL: Record<Tier, string> = { evacuate: "Evacuate", prepare: "Prepare", watch: "Watch" };

/** One readable line for an event, whatever its payload shape. */
export function describeEvent(event: EmberEvent): string {
  const p = event.payload as Record<string, unknown>;
  for (const key of ["message", "summary", "text", "reason"]) {
    const value = p[key];
    if (typeof value === "string" && value) return value;
  }
  return event.kind.replace(/_/g, " ");
}

function TierPill({ tier }: { tier: Tier }) {
  return <span className={cx(styles.tier, styles[tier])}>{TIER_LABEL[tier]}</span>;
}

/** Counts of residents per alert tier, shown while alerts are out. */
function TierCounts() {
  const recipients = useAppStore((s) => (s.activeZoneId ? s.recipients[s.activeZoneId] : undefined));
  if (!recipients) return null;
  const count = (t: Tier) => recipients.residents.filter((r) => r.tier === t).length;
  return (
    <div className={styles.counts} data-testid="tier-counts">
      {(["evacuate", "prepare", "watch"] as Tier[]).map((t) => (
        <span key={t} className={styles.countItem}>
          <TierPill tier={t} /> <span className={hud.mono}>{count(t)}</span>
        </span>
      ))}
      <span className={hud.simTag}>SIM</span>
    </div>
  );
}

// --- Log --------------------------------------------------------------------------

interface Run {
  id: string;
  trigger: string;
  mode: AgentMode;
  ts: string;
  steps: EmberEvent<"log", AgentLog>[];
  decisions: EmberEvent<"decision", Decision>[];
}

type LogItem = { type: "run"; run: Run; ts: string } | { type: "event"; event: EmberEvent; ts: string };

function Step({ event }: { event: EmberEvent<"log", AgentLog> }) {
  const [open, setOpen] = useState(false);
  const p = event.payload;
  const hasDetail = p.args !== undefined || p.result !== undefined;
  return (
    <li className={styles.step}>
      <button type="button" className={styles.stepHead} onClick={() => setOpen(!open)} disabled={!hasDetail} aria-expanded={open}>
        <span className={styles.tool}>{p.tool ?? "note"}</span>
        <span className={styles.stepText}>{p.message}</span>
      </button>
      {open && hasDetail && (
        <pre className={styles.detail}>
          {p.args !== undefined && `args   ${JSON.stringify(p.args, null, 1)}\n`}
          {p.result !== undefined && `result ${JSON.stringify(p.result, null, 1)}`}
        </pre>
      )}
    </li>
  );
}

function RunCard({ run }: { run: Run }) {
  return (
    <li className={styles.run} data-testid="agent-run">
      <div className={styles.runHead}>
        <span className={cx(hud.mono, hud.muted)}>{formatClock(run.ts)}</span>
        <span className={cx(styles.mode, run.mode === "asi1" && styles.modeAsi)}>{MODE_LABEL[run.mode]}</span>
      </div>
      <div className={styles.trigger}>{run.trigger}</div>
      {run.steps.length > 0 && (
        <ol className={styles.steps}>
          {run.steps.map((e, i) => (
            <Step key={i} event={e} />
          ))}
        </ol>
      )}
      {run.decisions.map((d, i) => (
        <div key={i} className={styles.decision}>
          <span className={hud.label}>Decision</span>
          <p>{d.payload.summary}</p>
          {d.payload.actions && d.payload.actions.length > 0 && (
            <ul>
              {d.payload.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </li>
  );
}

function LogTab() {
  const log = useAppStore((s) => s.log);
  const runs = useAppStore((s) => s.agentRuns);

  const items = useMemo<LogItem[]>(() => {
    const byRun = new Map<string, Run>();
    const out: LogItem[] = [];
    for (const event of log) {
      const runId = (event.payload as { run_id?: string }).run_id;
      if (event.kind === "agent_run" && runId) {
        const meta = runs[runId];
        const run: Run = { id: runId, trigger: meta?.trigger ?? "", mode: meta?.mode ?? "fallback", ts: event.ts, steps: [], decisions: [] };
        byRun.set(runId, run);
        out.push({ type: "run", run, ts: event.ts });
      } else if (runId && byRun.has(runId) && event.kind === "log") {
        byRun.get(runId)!.steps.push(event as EmberEvent<"log", AgentLog>);
      } else if (runId && byRun.has(runId) && event.kind === "decision") {
        byRun.get(runId)!.decisions.push(event as EmberEvent<"decision", Decision>);
      } else if (event.kind !== "approval_request") {
        out.push({ type: "event", event, ts: event.ts });
      }
    }
    return out.reverse();
  }, [log, runs]);

  if (items.length === 0) {
    return (
      <div className={hud.empty}>
        <strong>No agent activity yet</strong>
        Draw a watch zone and deploy edge servers, or run the demo. Every agent run and step shows up here.
      </div>
    );
  }
  return (
    <ol className={cx(styles.log, hud.scroll)}>
      {items.map((item, i) =>
        item.type === "run" ? (
          <RunCard key={item.run.id} run={item.run} />
        ) : (
          <li key={`${item.ts}-${i}`} className={styles.entry}>
            <span className={cx(hud.mono, hud.muted)}>{formatClock(item.ts)}</span>
            <span className={styles.kind}>{item.event.kind.replace(/_/g, " ")}</span>
            <span className={styles.text}>{describeEvent(item.event)}</span>
          </li>
        ),
      )}
    </ol>
  );
}

// --- Approvals -----------------------------------------------------------------------

function ApprovalCard({ event }: { event: EmberEvent<"approval_request", ApprovalRequest> }) {
  const a = event.payload;
  const [busy, setBusy] = useState(false);
  const act = async (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    await fn(a.id);
    setBusy(false);
  };
  return (
    <li className={styles.approval} data-testid="approval-card">
      <div className={styles.runHead}>
        <span className={cx(hud.mono, hud.muted)}>{formatClock(event.ts)}</span>
        {a.tier && <TierPill tier={a.tier} />}
        {a.recipients_count !== undefined && <span className={styles.recipients}>{a.recipients_count} residents</span>}
      </div>
      <p className={styles.reason}>
        <span className={hud.label}>Held because</span> {a.reason}
      </p>
      {a.texts.map((t) => (
        <blockquote key={t} className={styles.quote}>
          {t}
        </blockquote>
      ))}
      <div className={styles.actions}>
        <button type="button" className={cx(hud.button, hud.primary)} disabled={busy} onClick={() => void act(approveAlert)}>
          Approve alerts
        </button>
        <button type="button" className={hud.button} disabled={busy} onClick={() => void act(holdAlert)}>
          Hold
        </button>
      </div>
    </li>
  );
}

function ApprovalsTab() {
  const approvals = useAppStore((s) => s.approvals);
  const notifications = useAppStore((s) => s.notifications);
  const pending = Object.values(approvals);
  const sent = [...notifications].reverse();
  return (
    <div className={cx(styles.log, hud.scroll)}>
      <div className={styles.sectionTitle}>Waiting for approval</div>
      {pending.length === 0 ? (
        <div className={hud.empty}>
          Nothing waiting. Alerts the agent cannot send on its own, such as for a fire not yet confirmed by a drone, wait here for you.
        </div>
      ) : (
        <ol className={styles.plain}>
          {pending.map((e) => (
            <ApprovalCard key={e.payload.id} event={e} />
          ))}
        </ol>
      )}
      <div className={styles.sectionTitle}>Sent alerts</div>
      {sent.length === 0 ? (
        <div className={hud.empty}>No alerts sent yet.</div>
      ) : (
        <ol className={styles.plain} data-testid="sent-alerts">
          {sent.map((n) => (
            <li key={n.id} className={styles.sent}>
              <div className={styles.runHead}>
                <span className={cx(hud.mono, hud.muted)}>{n.ts ? formatClock(n.ts) : ""}</span>
                <TierPill tier={n.tier} />
                <span className={styles.recipients}>{n.recipients_count} residents</span>
                <span className={hud.simTag}>SIM</span>
              </div>
              <p className={styles.sentText}>{n.text}</p>
              <p className={styles.by}>{n.approved_by === "operator" ? "Approved by the operator" : `Sent by ${n.approved_by ?? "the agent"}`}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// --- Chat ----------------------------------------------------------------------------

interface ChatMessage {
  from: "operator" | "agent";
  text: string;
}

function ChatTab() {
  const zoneId = useAppStore((s) => s.activeZoneId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLLIElement>(null);

  const send = async (message: string) => {
    const clean = message.trim();
    if (!clean || busy) return;
    setMessages((m) => [...m, { from: "operator", text: clean }]);
    setText("");
    setBusy(true);
    const reply = await sendChat(zoneId, clean);
    setBusy(false);
    if (reply) {
      setMessages((m) => [...m, { from: "agent", text: reply }]);
      voice.speak(reply);
    }
  };
  const voice = useVoice((heard) => void send(heard));

  // Block body on purpose: scrollIntoView returns a Promise in newer engines,
  // and an effect may only return a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  return (
    <div className={styles.chat}>
      {messages.length === 0 ? (
        <div className={hud.empty}>
          <strong>Talk to the agent</strong>
          Try "status", "approve", or "fire near Sierra Madre". Hold Space to talk.
        </div>
      ) : (
        <ol className={cx(styles.thread, hud.scroll)} data-testid="chat-thread">
          {messages.map((m, i) => (
            <li key={i} className={cx(styles.bubble, m.from === "agent" ? styles.agent : styles.operator)}>
              {m.text}
            </li>
          ))}
          <li ref={end} />
        </ol>
      )}
      <div className={styles.voice} data-testid="voice-status">
        <span className={cx(styles.dot, voice.listening && styles.dotOn)} />
        {voice.status}
      </div>
      <form className={styles.chatForm} onSubmit={submit}>
        <input
          className={cx(hud.input, styles.chatInput)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask the agent"
          aria-label="Message to the agent"
        />
        <button type="submit" className={cx(hud.button, hud.primary)} disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export function AgentPanel() {
  const tab = useAppStore((s) => s.agentTab);
  const setTab = useAppStore((s) => s.setAgentTab);
  const pendingCount = useAppStore((s) => Object.keys(s.approvals).length);
  const hasReport = useAppStore((s) => (s.activeZoneId ? Boolean(s.reports[s.activeZoneId]) : false));

  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Agent">
      <div className={hud.header}>
        <h2 className={hud.title}>Agent</h2>
        {hasReport && (
          <button type="button" className={styles.link} onClick={() => useAppStore.getState().setRightPanel("report")}>
            Open report
          </button>
        )}
      </div>
      <TierCounts />
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
            {t.id === "approvals" && pendingCount > 0 && <span className={styles.count}>{pendingCount}</span>}
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
