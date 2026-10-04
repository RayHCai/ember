import { motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import { useDroneInfo } from '../live/droneInfo';
import { getTelemetry, isAirborne } from '../live/telemetry';
import type { ZoneView } from '../model/types';
import { hectares, riskTotals } from '../model/zone';
import { stopScan } from '../store/actions';
import { QUICK, SMOOTH } from '../ui/motion';
import { useNow } from '../ui/useNow';
import styles from './Overlay.module.css';

function elapsed(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, '0')}s`;
}

/** The live scan readout: progress, drones in the air, and what they have found. */
export function ScanHud({ zone }: { zone: ZoneView }) {
    const now = useNow(500);
    const live = useDroneInfo((s) => s.connected);
    const scan = zone.scan;
    if (!scan) return null;
    const airborne = zone.drones.filter((d) => isAirborne(getTelemetry(d.id))).length;
    const { atRiskHa, onFireHa } = riskTotals(zone.riskZones);
    const progress = scan.coverage;

    return (
        <motion.div
            className={styles.hud}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16, transition: QUICK }}
            transition={SMOOTH}
        >
            <span className={styles.hudLive} data-off={!live}>
                <span className={styles.hudDot} /> {live ? 'Live' : 'No feed'}
            </span>
            <div className={styles.hudMain}>
                <div className={styles.hudTop}>
                    <strong>
                        {scan.state === 'starting'
                            ? `Launching over ${zone.name}`
                            : scan.state === 'stopping'
                              ? `Returning from ${zone.name}`
                              : `Scanning ${zone.name}`}
                    </strong>
                    <span>{Math.round(progress * 100)}%</span>
                </div>
                <div className={styles.hudBar}>
                    <motion.span
                        animate={{ width: `${progress * 100}%` }}
                        transition={{ duration: 0.4 }}
                    />
                </div>
                <div className={styles.hudStats}>
                    <span>{airborne} airborne</span>
                    <span data-tone={atRiskHa ? 'risk' : undefined}>
                        {hectares(atRiskHa)} ha at risk
                    </span>
                    <span data-tone={onFireHa ? 'fire' : undefined}>
                        {hectares(onFireHa)} ha on fire
                    </span>
                    <span>{elapsed(now - Date.parse(scan.startedAt))}</span>
                </div>
            </div>
            <button
                type="button"
                className={styles.hudStop}
                onClick={() => void stopScan(zone.id, scan.runId)}
                disabled={scan.state === 'stopping'}
                aria-label="Stop scan"
            >
                <Icon name="stop" size={14} />
            </button>
        </motion.div>
    );
}
