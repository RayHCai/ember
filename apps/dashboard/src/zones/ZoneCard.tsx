import { motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import type { MouseEvent } from 'react';
import { Icon } from '../icons/Icon';
import { LiveBadge } from '../live/LiveStatus';
import { useLive } from '../live/store';
import { navigate } from '../store/router';
import type { WatchZone } from '../sim/types';
import { deployedCoverage, riskCounts, setupStep, zoneStatus } from '../sim/world';
import { ago, until } from '../ui/format';
import { StatusPill } from '../ui/StatusPill';
import styles from './ZonesPage.module.css';
import { ZoneShape } from './ZoneShape';

const STEP_ROUTE = { 2: 'servers', 3: 'drones' } as const;

export function ZoneCard({ zone }: { zone: WatchZone }) {
    const status = zoneStatus(zone);
    const step = setupStep(zone);
    const { atRisk, onFire } = riskCounts(zone);
    const deployed = zone.servers.filter((s) => s.status === 'deployed').length;
    const coverage = deployed ? deployedCoverage(zone) : 0;
    const incident = useLive((s) => (zone.live ? s.incident : null));
    const waiting = useLive((s) => (zone.live ? s.alerts.length : 0));
    const drones = zone.live
        ? zone.servers.reduce((n, s) => n + (s.live?.connectedDrones ?? 0), 0)
        : zone.drones.length;

    // A slight tilt toward the pointer.
    const px = useMotionValue(0.5);
    const py = useMotionValue(0.5);
    const rotateX = useSpring(useTransform(py, [0, 1], [4, -4]), { stiffness: 260, damping: 22 });
    const rotateY = useSpring(useTransform(px, [0, 1], [-5, 5]), { stiffness: 260, damping: 22 });
    const onMove = (e: MouseEvent<HTMLElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        px.set((e.clientX - r.left) / r.width);
        py.set((e.clientY - r.top) / r.height);
    };
    const onLeave = () => {
        px.set(0.5);
        py.set(0.5);
    };

    return (
        <motion.article
            layout
            className={styles.card}
            data-status={status}
            style={{ rotateX, rotateY, transformPerspective: 900 }}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
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
                    <ZoneShape zone={zone} />
                </div>
                <div className={styles.cardBadges}>
                    <StatusPill status={status} step={step} />
                    {zone.live ? <LiveBadge /> : null}
                    {zone.scan ? (
                        <span className={styles.livePill}>
                            <span className={styles.liveDot} /> Scanning{' '}
                            {Math.round(zone.scan.progress * 100)}%
                        </span>
                    ) : null}
                </div>
                <span className={styles.cardOpen}>
                    <Icon name="arrowRight" size={16} />
                </span>
            </div>
            <div className={styles.cardBody}>
                <motion.h3 layoutId={`zone-title-${zone.id}`} className={styles.cardTitle}>
                    {zone.name}
                </motion.h3>
                <p className={styles.cardRegion}>
                    <Icon name="pin" size={13} /> {zone.region}
                </p>
                <dl className={styles.metrics}>
                    <div>
                        <dt>Coverage</dt>
                        <dd data-low={deployed > 0 && coverage < 90}>
                            {deployed ? `${coverage}%` : '—'}
                        </dd>
                    </div>
                    <div>
                        <dt>Servers</dt>
                        <dd>{zone.servers.length ? `${deployed}/${zone.servers.length}` : '0'}</dd>
                    </div>
                    <div>
                        <dt>Drones</dt>
                        <dd>{drones}</dd>
                    </div>
                    <div>
                        <dt>Area</dt>
                        <dd>{zone.areaKm2} km²</dd>
                    </div>
                </dl>
            </div>
            <div className={styles.cardFoot}>
                {zone.live ? (
                    <>
                        <span>
                            <Icon name="flame" size={13} />{' '}
                            {incident
                                ? `Incident #${incident.number} · ${incident.state}`
                                : 'No open incident'}
                        </span>
                        <span className={styles.footRight}>
                            {waiting ? (
                                <b className={styles.fireText}>
                                    {waiting} alert{waiting === 1 ? '' : 's'} to approve
                                </b>
                            ) : onFire ? (
                                <b className={styles.fireText}>Fire on the map</b>
                            ) : (
                                'Watching'
                            )}
                        </span>
                    </>
                ) : step ? (
                    <button
                        type="button"
                        className={styles.setupCta}
                        onClick={(e) => {
                            e.stopPropagation();
                            navigate({
                                name: 'setup',
                                zoneId: zone.id,
                                step: STEP_ROUTE[step === 1 ? 2 : step],
                            });
                        }}
                    >
                        <Icon name={step === 2 ? 'server' : 'drone'} size={14} />
                        {step === 2 ? 'Place edge servers' : 'Pair drones'}
                        <Icon name="chevronRight" size={12} />
                    </button>
                ) : (
                    <>
                        <span>
                            <Icon name="radar" size={13} /> Scanned {ago(zone.lastScanAt)}
                        </span>
                        <span className={styles.footRight}>
                            {onFire ? (
                                <b className={styles.fireText}>{onFire} ha burning</b>
                            ) : atRisk ? (
                                <b className={styles.riskText}>{atRisk} ha at risk</b>
                            ) : zone.schedule.enabled ? (
                                `Next ${until(zone.schedule.nextAt)}`
                            ) : (
                                'Manual scans'
                            )}
                        </span>
                    </>
                )}
            </div>
        </motion.article>
    );
}
