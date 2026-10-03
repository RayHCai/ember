import { useEffect, useState } from "react";
import { isTypingTarget } from "../hooks/useHotkeys";
import { cx } from "../lib/format";
import hud from "./hud.module.css";
import styles from "./ShortcutsOverlay.module.css";

const SHORTCUTS: [string, string][] = [
  ["1 2 3 4", "Map filter: Normal, Thermal, Night, CRT"],
  ["Space (hold)", "Talk to the agent, on the Chat tab"],
  ["Esc", "Cancel drawing, or close this list"],
  ["Backspace", "Remove the last point while drawing a zone"],
  ["Enter", "Close the zone outline while drawing"],
  ["Right-click", "Remove an edge server or shelter while editing"],
  ["?", "Show or hide this list"],
];

/** Press ? for the keyboard shortcuts. */
export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "?") setOpen((o) => !o);
      else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <div className={styles.backdrop} onClick={() => setOpen(false)}>
      <section
        className={cx(hud.panel, styles.panel)}
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={hud.header}>
          <h2 className={hud.title}>Keyboard shortcuts</h2>
          <button type="button" className={styles.close} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        <dl className={styles.list}>
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className={styles.row}>
              <dt>
                {keys.split(" ").length > 1 && !keys.includes("(") ? (
                  keys.split(" ").map((k) => <kbd key={k}>{k}</kbd>)
                ) : (
                  <kbd>{keys}</kbd>
                )}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
