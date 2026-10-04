import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import { ago } from '../ui/format';
import { useNow } from '../ui/useNow';
import styles from './Live.module.css';
import { LIVE_POLL_MS } from './poller';
import { useLive, type LiveStatus } from './store';

const STATUS_LABEL: Record<LiveStatus, string> = {
    off: 'Live unavailable',
    connecting: 'Connecting',
    online: 'Live',
    error: 'Offline',
};

export function LiveBadge() {
    const status = useLive((s) => s.status);
    return (
        <span className={styles.liveBadge} data-status={status}>
            <span className={styles.liveDot} />
            {STATUS_LABEL[status]}
        </span>
    );
}

/** The live zone at a glance: open incident, last plan, alerts waiting, and connection trouble. */
export function LiveStrip() {
    const now = useNow(1000);
    const status = useLive((s) => s.status);
    const error = useLive((s) => s.error);
    const lastSyncAt = useLive((s) => s.lastSyncAt);
    const incident = useLive((s) => s.incident);
    const plan = useLive((s) => s.plan);
    const waiting = useLive((s) => s.alerts.length);

    return (
        <div className={styles.strip}>
            <motion.div
                className={styles.stripCard}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
            >
                <LiveBadge />
                <span className={styles.stripItem} data-tone={incident ? 'fire' : undefined}>
                    <Icon name="flame" size={13} />
                    {incident ? (
                        <strong>
                            Incident #{incident.number} · {incident.state}
                        </strong>
                    ) : (
                        'No open incident'
                    )}
                </span>
                <span className={styles.stripItem}>
                    <Icon name="route" size={13} />
                    {plan ? `Plan ${ago(plan.generatedAt, now)}` : 'No plan yet'}
                </span>
                <span className={styles.stripItem} data-tone={waiting ? 'flame' : undefined}>
                    <Icon name="megaphone" size={13} />
                    {waiting ? (
                        <strong>
                            {waiting} alert{waiting === 1 ? '' : 's'} awaiting approval
                        </strong>
                    ) : (
                        'No alerts waiting'
                    )}
                </span>
            </motion.div>
            <AnimatePresence>
                {status === 'error' || status === 'off' ? (
                    <motion.div
                        key="banner"
                        className={styles.banner}
                        role="status"
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                    >
                        <Icon name="alert" size={16} />
                        <span>
                            <strong>
                                {status === 'off'
                                    ? 'Live system unavailable'
                                    : `Can't reach the Ember api. Retrying every ${LIVE_POLL_MS / 1000} s.`}
                            </strong>
                            <small>
                                {status === 'off'
                                    ? 'This build has no api proxy; run the dev server.'
                                    : `Showing data from ${ago(lastSyncAt, now)}. ${error ?? ''}`}
                            </small>
                        </span>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}

/** On the zone list, when the live zone cannot be shown at all. */
export function LiveNotice() {
    const status = useLive((s) => s.status);
    const zoneId = useLive((s) => s.zoneId);
    const error = useLive((s) => s.error);
    if (zoneId || (status !== 'off' && status !== 'error')) return null;
    return (
        <p className={styles.notice} role="status" title={error ?? undefined}>
            <LiveBadge />
            Live system unavailable. The simulated zones below still work.
        </p>
    );
}
