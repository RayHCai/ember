import type { WatchZoneSummary } from '@ember/contracts';
import { motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import { areaKm2, hectares, isActiveScan, summaryStatus, summaryStep } from '../model/zone';
import { navigate } from '../store/router';
import { ago, until } from '../ui/format';
import { StatusPill } from '../ui/StatusPill';
import styles from './ZonesPage.module.css';
import { ZoneShape } from './ZoneShape';

const STEP_ROUTE = { 2: 'servers', 3: 'drones' } as const;

export function ZoneCard({ zone }: { zone: WatchZoneSummary }) {
    const { summary } = zone;
    const status = summaryStatus(zone);
    const step = summaryStep(zone);
    const { onFireM2, atRiskM2 } = summary.riskZones;
    const coverage = Math.round(summary.coverage * 1000) / 10;
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
                <p className={styles.cardRegion}>{zone.region}</p>
                <dl className={styles.metrics}>
                    <div>
                        <dt>Coverage</dt>
                        <dd data-low={summary.edgeServers > 0 && coverage < 90}>
                            {summary.edgeServers ? `${coverage}%` : '—'}
                        </dd>
                    </div>
                    <div>
                        <dt>Servers</dt>
                        <dd>
                            {summary.placements
                                ? `${summary.edgeServers}/${summary.edgeServers + summary.placements}`
                                : summary.edgeServers}
                        </dd>
                    </div>
                    <div>
                        <dt>Drones</dt>
                        <dd>{summary.drones}</dd>
                    </div>
                    <div>
                        <dt>Area</dt>
                        <dd>{areaKm2(zone.boundary)} km²</dd>
                    </div>
                </dl>
            </div>
            <div className={styles.cardFoot}>
                {step ? (
                    <button
                        type="button"
                        className={styles.setupCta}
                        onClick={(e) => {
                            e.stopPropagation();
                            navigate({ name: 'setup', zoneId: zone.id, step: STEP_ROUTE[step] });
                        }}
                    >
                        {step === 2 ? 'Place edge servers' : 'Pair drones'}
                        <Icon name="arrowRight" size={12} />
                    </button>
                ) : (
                    <>
                        <span>Scanned {ago(lastScanAt)}</span>
                        <span>
                            {onFireM2 ? (
                                <b className={styles.fireText}>
                                    {hectares(onFireM2 / 10_000)} ha burning
                                </b>
                            ) : atRiskM2 ? (
                                <b className={styles.riskText}>
                                    {hectares(atRiskM2 / 10_000)} ha at risk
                                </b>
                            ) : zone.nextScanAt ? (
                                `Next ${until(Date.parse(zone.nextScanAt))}`
                            ) : (
                                'Manual scans'
                            )}
                        </span>
                    </>
                )}
            </div>
        </article>
    );
}
