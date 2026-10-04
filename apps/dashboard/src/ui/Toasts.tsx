import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { useNotices, type Severity } from '../store/notifications';
import { QUICK, SMOOTH } from './motion';
import styles from './ui.module.css';

export const SEVERITY_ICON: Record<Severity, GlyphName> = {
    info: 'radar',
    success: 'check',
    warning: 'alert',
    critical: 'flame',
};

const TOAST_SECONDS: Record<Severity, number> = { info: 5, success: 5, warning: 8, critical: 11 };

/** Live notifications, newest at the bottom of the stack. */
export function Toasts() {
    const notices = useNotices((s) => s.notices);
    const toasts = useNotices((s) => s.toasts);
    const dismiss = useNotices((s) => s.dismissToast);
    const shown = toasts
        .map((id) => notices.find((n) => n.id === id))
        .filter((n) => n !== undefined);

    return (
        <div className={styles.toasts} aria-live="polite">
            <AnimatePresence initial={false}>
                {shown.map((n) => (
                    <motion.div
                        key={n.id}
                        layout
                        className={styles.toast}
                        data-severity={n.severity}
                        role={n.severity === 'critical' ? 'alert' : 'status'}
                        initial={{ opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 16, transition: QUICK }}
                        transition={SMOOTH}
                    >
                        <span className={styles.toastIcon}>
                            <Icon name={SEVERITY_ICON[n.severity]} size={16} />
                        </span>
                        <div>
                            <div className={styles.toastTitle}>
                                {n.title}
                                {n.zoneName ? (
                                    <span className={styles.toastZone}> · {n.zoneName}</span>
                                ) : null}
                            </div>
                            {n.body ? <div className={styles.toastBody}>{n.body}</div> : null}
                            {n.pushed ? (
                                <div className={styles.toastMeta}>
                                    <Icon name="phone" size={12} /> Push sent to {n.pushed}{' '}
                                    responder{n.pushed === 1 ? '' : 's'}
                                </div>
                            ) : null}
                        </div>
                        <button
                            type="button"
                            aria-label="Dismiss"
                            className={styles.toastClose}
                            onClick={() => dismiss(n.id)}
                        >
                            <Icon name="close" size={12} />
                        </button>
                        <motion.span
                            className={styles.toastTimer}
                            initial={{ scaleX: 1 }}
                            animate={{ scaleX: 0 }}
                            transition={{ duration: TOAST_SECONDS[n.severity], ease: 'linear' }}
                        />
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
}
