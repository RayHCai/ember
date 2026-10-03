import { cx } from "../lib/format";
import { useToasts } from "../state/toasts";
import hud from "./hud.module.css";
import styles from "./Toasts.module.css";

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx(hud.panel, styles.toast, t.tone === "error" && styles.error)}>
          <span className={styles.message}>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className={cx(hud.button, hud.primary)}
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
