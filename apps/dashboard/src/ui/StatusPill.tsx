import type { ZoneStatus } from '../model/types';
import styles from './ui.module.css';

const LABEL: Record<ZoneStatus, string> = {
    on_fire: 'Active fire',
    at_risk: 'At risk',
    healthy: 'Healthy',
    setup: 'Waiting',
    awaiting: 'Awaiting scan',
};

export function StatusPill({ status, step }: { status: ZoneStatus; step?: number | null }) {
    return (
        <span className={styles.pill} data-status={status}>
            <span className={styles.dot} />
            {status !== 'setup'
                ? LABEL[status]
                : step === 3
                  ? 'Waiting for drones'
                  : 'Waiting for edge server'}
        </span>
    );
}
