import type { ZoneStatus } from '../sim/types';
import styles from './ui.module.css';

const LABEL: Record<ZoneStatus, string> = {
    on_fire: 'Active fire',
    at_risk: 'At risk',
    healthy: 'Healthy',
    setup: 'Setup',
    awaiting: 'Awaiting scan',
};

export function StatusPill({ status, step }: { status: ZoneStatus; step?: number | null }) {
    return (
        <span className={styles.pill} data-status={status}>
            <span className={styles.dot} />
            {status === 'setup' && step ? `Setup ${step - 1} of 3` : LABEL[status]}
        </span>
    );
}
