import { motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import { getTelemetry } from '../sim/live';
import { stopScan } from '../sim/scan';
import type { WatchZone } from '../sim/types';
import { riskCounts } from '../sim/world';
import { useNow } from '../ui/useNow';
import styles from './Overlay.module.css';

/** The live scan readout: progress, drones in the air, and what they have found. */
export function ScanHud({ zone }: { zone: WatchZone }) {
    const now = useNow(500);
    if (!zone.scan) return null;
    const airborne = zone.drones.filter((d) => {
        const s = getTelemetry(d.id)?.state;
        return s === 'scanning' || s === 'launching' || s === 'returning';
    }).length;
    const { atRisk, onFire } = riskCounts(zone);
    const secondsLeft = Math.max(0, Math.round((zone.scan.endsAt - now) / 1000));

    return (
        <motion.div
            className={styles.hud}
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
        >
            <span className={styles.hudLive}>
                <span className={styles.hudDot} /> Live
            </span>
            <div className={styles.hudMain}>
                <div className={styles.hudTop}>
                    <strong>Scanning {zone.name}</strong>
                    <span className="mono">{Math.round(zone.scan.progress * 100)}%</span>
                </div>
                <div className={styles.hudBar}>
                    <motion.span
                        animate={{ width: `${zone.scan.progress * 100}%` }}
                        transition={{ duration: 0.2 }}
                    />
                </div>
                <div className={styles.hudStats}>
                    <span>
                        <Icon name="drone" size={12} /> {airborne} airborne
                    </span>
                    <span data-tone={atRisk ? 'risk' : undefined}>{atRisk} ha at risk</span>
                    <span data-tone={onFire ? 'fire' : undefined}>{onFire} ha on fire</span>
                    <span>~{secondsLeft}s left</span>
                </div>
            </div>
            <button
                type="button"
                className={styles.hudStop}
                onClick={() => stopScan(zone.id)}
                aria-label="Stop scan"
            >
                <Icon name="stop" size={14} />
            </button>
        </motion.div>
    );
}
