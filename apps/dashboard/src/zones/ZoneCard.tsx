import type { WatchZoneSummary } from '@ember/contracts';
import { motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import { hectares, isActiveScan, summaryStatus, summaryStep } from '../model/zone';
import { navigate } from '../store/router';
import { ago } from '../ui/format';
import { StatusPill } from '../ui/StatusPill';
import styles from './ZonesPage.module.css';
import { ZoneShape } from './ZoneShape';

export function ZoneCard({ zone }: { zone: WatchZoneSummary }) {
    const { summary } = zone;
    const status = summaryStatus(zone);
    const step = summaryStep(zone);
    const { onFireM2, atRiskM2 } = summary.riskZones;
    const scan = summary.lastScan;
    const scanning = isActiveScan(scan);
    const lastScanAt = scan?.state === 'done' ? Date.parse(scan.endedAt ?? scan.updatedAt) : null;

    return (
        <article
            className={styles.card}
            onClick={() => navigate({ name: 'zone', zoneId: zone.id })}
            tabIndex={0}
            role="link"
            aria-label={`Open ${zone.name}`}
            onKeyDown={(e) => {
                if (e.key === 'Enter') navigate({ name: 'zone', zoneId: zone.id });
            }}
        >
            <div className={styles.cardVisual}>
                <div className={styles.cardShape}>
                    <ZoneShape boundary={zone.boundary} status={status} />
                </div>
            </div>
            <div className={styles.cardBody}>
                <div className={styles.cardStatus}>
                    <StatusPill status={status} step={step} />
                    {scanning && scan ? (
                        <span className={styles.scanning}>
                            Scanning {Math.round(scan.coverage * 100)}%
                        </span>
                    ) : null}
                </div>
                <div className={styles.cardHead}>
                    <motion.h3 layoutId={`zone-title-${zone.id}`} className={styles.cardTitle}>
                        {zone.name}
                    </motion.h3>
                    <span className={styles.cardOpen}>
                        <Icon name="arrowRight" size={14} />
                    </span>
                </div>
            </div>
            {step ? null : (
                <div className={styles.cardFoot}>
                    <span>Scanned {ago(lastScanAt)}</span>
                    {onFireM2 ? (
                        <b className={styles.fireText}>{hectares(onFireM2 / 10_000)} ha burning</b>
                    ) : atRiskM2 ? (
                        <b className={styles.riskText}>{hectares(atRiskM2 / 10_000)} ha at risk</b>
                    ) : null}
                </div>
            )}
        </article>
    );
}
