import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { getTelemetry, isAirborne } from '../live/telemetry';
import { computeCoverage } from '../model/geo';
import { mappedCells, mappedShare } from '../model/raster';
import type { ZoneView } from '../model/types';
import {
    coveragePct,
    deployed as deployedOf,
    hectares,
    riskTotals,
    setupStep,
} from '../model/zone';
import {
    DEFAULT_RADIUS_M,
    runPlanner,
    setSchedule,
    startScan,
    stopScan,
    suggestPlacements,
} from '../store/actions';
import { navigate } from '../store/router';
import { useUi } from '../store/ui';
import { Button } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { ago, until } from '../ui/format';
import { SMOOTH } from '../ui/motion';
import panel from '../ui/panel.module.css';
import { Toggle } from '../ui/Toggle';
import { useNow } from '../ui/useNow';
import styles from './OperatorPanel.module.css';

const INTERVALS = [1, 3, 6, 12, 24];

const REVEAL = {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: 'auto' },
    exit: { opacity: 0, height: 0 },
    transition: SMOOTH,
};

const JOB_LABEL: Record<string, string> = {
    queued: 'Queued',
    gathering: 'Gathering data',
    planning: 'Planning',
};

function Planner({
    icon,
    title,
    detail,
    ready,
}: {
    icon: GlyphName;
    title: string;
    detail: string;
    ready: boolean;
}) {
    return (
        <div className={styles.planner}>
            <span className={panel.itemIcon} data-tone={ready ? 'ink' : undefined}>
                <Icon name={icon} size={15} />
            </span>
            <span className={panel.itemText}>
                <strong>{title}</strong>
                <span>{detail}</span>
            </span>
        </div>
    );
}

export function OperatorPanel({ zone }: { zone: ZoneView }) {
    useNow(1000);
    const select = useUi((s) => s.select);
    const setSuggestions = useUi((s) => s.setSuggestions);
    const setMode = useUi((s) => s.setMode);
    const openBlast = useUi((s) => s.openBlast);
    const [busy, setBusy] = useState<'scan' | 'stop' | 'suggest' | 'plan' | null>(null);

    const step = setupStep(zone);
    const deployed = deployedOf(zone);
    const pending = zone.servers.filter((s) => s.status === 'pending');
    const coverage = coveragePct(zone);
    const projected = pending.length ? computeCoverage(zone.grid, zone.servers).pct : coverage;
    const airborne = zone.drones.filter((d) => isAirborne(getTelemetry(d.id))).length;
    const risk = riskTotals(zone.riskZones);
    const currentRun = zone.scan?.runId ?? null;
    const mapped = useMemo(
        () => mappedShare(zone.grid, mappedCells(zone.grid, zone.runs, currentRun)),
        [zone.grid, zone.runs, currentRun],
    );
    const plan = zone.plan;
    const job = zone.planJob;
    const reached = plan?.civilianImpacts.filter((c) => c.impactMin !== null) ?? [];
    const routes = plan?.evacuationRoutes.filter((r) => r.status !== 'no_safe_route') ?? [];
    const planDetail = (ready: string) =>
        zone.planning && job
            ? `${JOB_LABEL[job.state] ?? job.state}…`
            : plan
              ? `${ready} · ${ago(zone.planAt)}`
              : job?.state === 'failed'
                ? `Failed: ${job.message ?? 'no reason given'}`
                : 'Not run yet';
    const radius = deployed[0]?.radiusM ?? DEFAULT_RADIUS_M;
    const failedScan = zone.lastScan?.state === 'failed' ? zone.lastScan : null;
    const pendingBlasts = zone.blasts.filter((b) => b.state === 'pending_approval');

    const act = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
        setBusy(kind);
        try {
            await fn();
        } finally {
            setBusy(null);
        }
    };

    return (
        <motion.aside
            className={styles.panel}
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24, transition: { duration: 0.15 } }}
            transition={SMOOTH}
        >
            <AnimatePresence initial={false}>
                {step ? (
                    <motion.div className={styles.setup} {...REVEAL}>
                        <div className={panel.section}>
                            <strong>Finish setting up</strong>
                            <Button
                                variant="primary"
                                block
                                iconAfter="arrowRight"
                                onClick={() =>
                                    navigate({
                                        name: 'setup',
                                        zoneId: zone.id,
                                        step: step === 2 ? 'servers' : 'drones',
                                    })
                                }
                            >
                                {step === 2 ? 'Place edge servers' : 'Pair drones'}
                            </Button>
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>

            <div className={panel.section}>
                <div className={styles.coverageHead}>
                    <span className={panel.sectionTitle}>Coverage</span>
                    <strong className={panel.big} data-low={deployed.length > 0 && coverage < 90}>
                        <CountUp value={coverage} decimals={1} suffix="%" />
                    </strong>
                </div>
                <div className={panel.bar} style={{ marginTop: 12 }}>
                    <motion.span
                        className={panel.barFill}
                        data-tone={coverage >= 90 ? 'ok' : undefined}
                        initial={false}
                        animate={{ width: `${coverage}%` }}
                        transition={SMOOTH}
                    />
                    <span className={panel.barMark} style={{ left: '90%' }} data-label="90%" />
                </div>

                <div className={styles.metrics}>
                    <button
                        type="button"
                        className={styles.metric}
                        onClick={() =>
                            deployed[0] && select({ kind: 'server', id: deployed[0].id })
                        }
                    >
                        <span className={panel.muted}>Edge servers</span>
                        <strong className={styles.metricValue}>
                            {deployed.length}
                            {pending.length ? <em> +{pending.length}</em> : null}
                        </strong>
                        <span className={panel.muted}>
                            {deployed.filter((s) => s.online).length} online
                        </span>
                    </button>
                    <button
                        type="button"
                        className={styles.metric}
                        onClick={() =>
                            zone.drones[0] && select({ kind: 'drone', id: zone.drones[0].id })
                        }
                    >
                        <span className={panel.muted}>Drones</span>
                        <strong className={styles.metricValue}>
                            {airborne ? `${airborne}/` : ''}
                            {zone.drones.length}
                        </strong>
                        <span className={panel.muted}>
                            {airborne ? 'airborne' : 'on the ground'}
                        </span>
                    </button>
                    <div className={styles.metric}>
                        <span className={panel.muted}>Mapped</span>
                        <strong className={styles.metricValue}>{Math.round(mapped * 100)}%</strong>
                        <span
                            className={panel.muted}
                            data-tone={risk.onFire ? 'fire' : risk.atRisk ? 'risk' : undefined}
                        >
                            {risk.onFire
                                ? `${hectares(risk.onFireHa)} ha fire`
                                : risk.atRisk
                                  ? `${hectares(risk.atRiskHa)} ha at risk`
                                  : 'no risk'}
                        </span>
                    </div>
                </div>

                <AnimatePresence initial={false}>
                    {deployed.length > 0 && (coverage < 90 || pending.length > 0) ? (
                        <motion.div className={styles.reveal} {...REVEAL}>
                            <div className={`${panel.callout} ${styles.gap}`} data-tone="pink">
                                <span>
                                    <strong>
                                        {pending.length
                                            ? `${pending.length} site${pending.length === 1 ? '' : 's'} planned`
                                            : 'Coverage is below 90%'}
                                    </strong>
                                    {pending.length ? `Lifts coverage to ${projected}%.` : null}
                                </span>
                                <span className={panel.row}>
                                    {pending.length ? (
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            onClick={() =>
                                                navigate({
                                                    name: 'setup',
                                                    zoneId: zone.id,
                                                    step: 'servers',
                                                })
                                            }
                                        >
                                            Assign servers
                                        </Button>
                                    ) : (
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            loading={busy === 'suggest'}
                                            onClick={() => {
                                                setMode('operator');
                                                void act('suggest', () =>
                                                    suggestPlacements(zone.id, radius),
                                                );
                                            }}
                                        >
                                            Suggest placements
                                        </Button>
                                    )}
                                </span>
                            </div>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>Fleet scan</span>
                    <span className={panel.muted}>Last {ago(zone.lastScanAt)}</span>
                </div>
                {zone.scan ? (
                    <div className={styles.scanLive}>
                        <div className={`${panel.row} ${panel.spread}`}>
                            <span className={styles.liveLabel}>
                                <span className={styles.liveDot} />
                                {zone.scan.state === 'starting'
                                    ? 'Launching'
                                    : zone.scan.state === 'stopping'
                                      ? 'Returning'
                                      : `Scanning ${Math.round(zone.scan.coverage * 100)}%`}
                            </span>
                            <Button
                                size="sm"
                                icon="stop"
                                loading={busy === 'stop'}
                                disabled={zone.scan.state === 'stopping'}
                                onClick={() =>
                                    void act('stop', () => stopScan(zone.id, zone.scan!.runId))
                                }
                            >
                                Stop
                            </Button>
                        </div>
                        <div className={panel.bar}>
                            <motion.span
                                className={panel.barFill}
                                data-tone="fire"
                                animate={{ width: `${zone.scan.coverage * 100}%` }}
                                transition={{ duration: 0.4 }}
                            />
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="primary"
                        block
                        icon="play"
                        loading={busy === 'scan'}
                        disabled={Boolean(step)}
                        onClick={() =>
                            void act('scan', async () => {
                                const scan = await startScan(zone.id);
                                if (scan && scan.state !== 'failed') setMode('detection');
                            })
                        }
                    >
                        Run scan now
                    </Button>
                )}
                {failedScan && !zone.scan ? (
                    <p className={panel.muted} data-tone="fire">
                        Last scan failed: {failedScan.error}
                    </p>
                ) : null}
                <div className={styles.schedule}>
                    <div className={`${panel.row} ${panel.spread}`}>
                        <span>
                            Repeat scan
                            <span className={panel.muted}>
                                {zone.schedule.enabled
                                    ? ` · next ${until(zone.schedule.nextAt)}`
                                    : ' · off'}
                            </span>
                        </span>
                        <Toggle
                            on={zone.schedule.enabled}
                            onChange={(enabled) =>
                                void setSchedule(zone.id, enabled ? zone.schedule.everyHours : null)
                            }
                            label="Repeat scan"
                            disabled={Boolean(step)}
                        />
                    </div>
                    <AnimatePresence initial={false}>
                        {zone.schedule.enabled ? (
                            <motion.div className={styles.reveal} {...REVEAL}>
                                <div className={styles.intervals}>
                                    <span className={panel.muted}>Every</span>
                                    {INTERVALS.map((h) => (
                                        <button
                                            key={h}
                                            type="button"
                                            data-active={zone.schedule.everyHours === h}
                                            onClick={() => void setSchedule(zone.id, h)}
                                        >
                                            {h}h
                                        </button>
                                    ))}
                                </div>
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>Path planners</span>
                    {plan ? (
                        <button
                            type="button"
                            className={styles.view}
                            onClick={() => setSuggestions(true)}
                        >
                            Show on map
                        </button>
                    ) : null}
                </div>
                <div className={styles.planners} data-running={zone.planning}>
                    <Planner
                        icon="users"
                        title="Civilian path plan"
                        ready={Boolean(plan)}
                        detail={planDetail(
                            `${reached.length} area${reached.length === 1 ? '' : 's'} reached, ${routes.length} route${routes.length === 1 ? '' : 's'}`,
                        )}
                    />
                    <Planner
                        icon="shield"
                        title="Responder path plan"
                        ready={Boolean(plan)}
                        detail={planDetail(
                            `${plan?.attackZones.length ?? 0} attack zone${plan?.attackZones.length === 1 ? '' : 's'}`,
                        )}
                    />
                </div>
                <Button
                    block
                    icon={plan ? 'refresh' : 'play'}
                    loading={zone.planning || busy === 'plan'}
                    disabled={Boolean(step)}
                    onClick={() => void act('plan', () => runPlanner(zone.id))}
                >
                    {plan ? 'Run planners again' : 'Run planners'}
                </Button>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>Event blasts</span>
                    {pendingBlasts.length ? (
                        <span className={panel.tag} data-tone="fire">
                            {pendingBlasts.length} to approve
                        </span>
                    ) : null}
                </div>
                <ul className={panel.list}>
                    {zone.blasts.slice(0, 4).map((b) => (
                        <li key={b.blastId}>
                            <button
                                type="button"
                                className={panel.item}
                                onClick={() =>
                                    b.state === 'pending_approval'
                                        ? openBlast(
                                              {
                                                  audience: b.audience,
                                                  priority: b.priority,
                                                  title: b.title,
                                                  body: b.body,
                                                  area: b.area,
                                              },
                                              true,
                                              b.blastId,
                                          )
                                        : undefined
                                }
                            >
                                <span
                                    className={panel.itemIcon}
                                    data-tone={b.state === 'pending_approval' ? 'fire' : undefined}
                                >
                                    <Icon name="megaphone" size={15} />
                                </span>
                                <span className={panel.itemText}>
                                    <strong>{b.title}</strong>
                                    <span>
                                        {b.audience} · {ago(Date.parse(b.createdAt))}
                                    </span>
                                </span>
                                <span
                                    className={panel.tag}
                                    data-tone={b.state === 'pending_approval' ? 'fire' : 'ok'}
                                >
                                    {b.state === 'pending_approval' ? 'Review' : 'Queued'}
                                </span>
                            </button>
                        </li>
                    ))}
                    {zone.blasts.length === 0 ? (
                        <li className={panel.muted}>No blasts yet</li>
                    ) : null}
                </ul>
            </div>

            <div className={`${panel.section} ${styles.zoneLinks}`}>
                <Button
                    size="sm"
                    variant="ghost"
                    icon="edit"
                    onClick={() => navigate({ name: 'setup', zoneId: zone.id, step: 'boundary' })}
                >
                    Edit boundary
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon="server"
                    onClick={() => navigate({ name: 'setup', zoneId: zone.id, step: 'servers' })}
                >
                    Edge servers
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon="drone"
                    disabled={!deployed.length}
                    onClick={() => navigate({ name: 'setup', zoneId: zone.id, step: 'drones' })}
                >
                    Drones
                </Button>
            </div>
        </motion.aside>
    );
}
