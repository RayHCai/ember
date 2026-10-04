import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { useNotices, type Severity } from '../store/notifications';
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
                        initial={{ opacity: 0, x: 60, scale: 0.94 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.2 } }}
                        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                    >
                        <motion.span
                            className={styles.toastIcon}
                            initial={{ scale: 0.4, rotate: -30 }}
                            animate={
                                n.severity === 'critical'
                                    ? { scale: [1, 1.12, 1], rotate: 0 }
                                    : { scale: 1, rotate: 0 }
                            }
                            transition={
                                n.severity === 'critical'
                                    ? {
                                          scale: { duration: 0.9, repeat: Infinity },
                                          rotate: { type: 'spring' },
                                      }
                                    : { type: 'spring', stiffness: 400, damping: 14 }
                            }
                        >
                            <Icon name={SEVERITY_ICON[n.severity]} size={17} />
                        </motion.span>
                        <div>
                            <div className={styles.toastTitle}>
                                {n.title}
                                {n.zoneName ? (
                                    <span style={{ color: 'var(--ink-3)', fontWeight: 500 }}>
                                        {' '}
                                        · {n.zoneName}
                                    </span>
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
                            onClick={() => dismiss(n.id)}
                            style={{
                                border: 0,
                                background: 'none',
                                color: 'var(--ink-3)',
                                padding: 2,
                            }}
                        >
                            <Icon name="close" size={14} />
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
