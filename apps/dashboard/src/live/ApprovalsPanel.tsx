import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../icons/Icon';
import { Button } from '../ui/Button';
import panel from '../ui/panel.module.css';
import { HoldButton } from '../zone/HoldButton';
import styles from './Live.module.css';
import type { LiveAlert } from './map';
import { decideAlert } from './poller';
import { useLive } from './store';

const SEVERITY_TONE: Record<LiveAlert['severity'], string> = {
    immediate: 'fire',
    warning: 'risk',
    watch: 'flame',
    clear: 'ok',
};

function AlertCard({ alert }: { alert: LiveAlert }) {
    const busy = useLive((s) => s.deciding.includes(alert.approval.id));
    // A failed decision remounts the hold button so it can be held again.
    const [attempt, setAttempt] = useState(0);
    const decide = (decision: 'approve' | 'reject') =>
        void decideAlert(alert, decision).then((ok) => {
            if (!ok) setAttempt((n) => n + 1);
        });

    return (
        <motion.article
            layout
            className={styles.alert}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 30, transition: { duration: 0.2 } }}
        >
            <div className={styles.alertHead}>
                <strong>
                    Approval {alert.number} · {alert.areaName}
                </strong>
                <span className={panel.tag} data-tone={SEVERITY_TONE[alert.severity]}>
                    {alert.severity}
                </span>
            </div>
            <span className={panel.muted}>
                {alert.recipients} recipient{alert.recipients === 1 ? '' : 's'} · code{' '}
                <span className={styles.code}>{alert.approval.confirmationCode}</span>
            </span>
            {alert.firstBody ? <p className={styles.alertBody}>{alert.firstBody}</p> : null}
            <div className={styles.alertActions}>
                <HoldButton
                    key={attempt}
                    label={busy ? 'Sending…' : 'Hold to approve and send'}
                    holdingLabel="Keep holding…"
                    onComplete={() => decide('approve')}
                />
                <Button variant="ghost" disabled={busy} onClick={() => decide('reject')}>
                    Reject
                </Button>
            </div>
        </motion.article>
    );
}

/** Civilian alerts Ember drafted; none leaves without a hold to approve here. */
export function ApprovalsPanel() {
    const alerts = useLive((s) => s.alerts);
    return (
        <motion.section
            layout
            className={`${panel.panel} ${styles.approvals}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        >
            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="megaphone" size={13} /> Alerts awaiting approval
                    </span>
                    <span className={panel.muted}>{alerts.length}</span>
                </div>
                <AnimatePresence initial={false}>
                    {alerts.map((a) => (
                        <AlertCard key={a.approval.id} alert={a} />
                    ))}
                </AnimatePresence>
                {alerts.length === 0 ? (
                    <p className={panel.muted}>
                        Nothing waiting. Ember drafts texts here when a plan puts civilians at risk.
                    </p>
                ) : null}
            </div>
        </motion.section>
    );
}
