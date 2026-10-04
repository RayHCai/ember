import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { deployPending, runPlanner, suggestPlacements } from '../sim/actions';
import { computeCoverage } from '../sim/geo';
import { getTelemetry } from '../sim/live';
import { startScan, stopScan } from '../sim/scan';
import type { WatchZone } from '../sim/types';
import { deployedCoverage, riskCounts, setupStep } from '../sim/world';
import { notify } from '../store/notifications';
import { navigate } from '../store/router';
import { useUi } from '../store/ui';
import { useZones } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { ago, until } from '../ui/format';
import panel from '../ui/panel.module.css';
import { Toggle } from '../ui/Toggle';
import styles from './OperatorPanel.module.css';

const INTERVALS = [1, 3, 6, 12, 24];

function useTick(ms: number): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setTick((t) => t + 1), ms);
        return () => window.clearInterval(timer);
    }, [ms]);
    return tick;
}

function CoverageRing({ pct }: { pct: number }) {
    const r = 26;
    const c = 2 * Math.PI * r;
    return (
        <svg width="64" height="64" viewBox="0 0 64 64" className={styles.ring}>
            <circle cx="32" cy="32" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="7" />
            <motion.circle
                cx="32"
                cy="32"
                r={r}
                fill="none"
                stroke={pct >= 90 ? 'var(--ok)' : 'url(#flame-ring)'}
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={c}
                initial={{ strokeDashoffset: c }}
                animate={{ strokeDashoffset: c * (1 - pct / 100) }}
                transition={{ type: 'spring', stiffness: 60, damping: 18 }}
                transform="rotate(-90 32 32)"
            />
            <defs>
                <linearGradient id="flame-ring" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0" stopColor="#FFB347" />
                    <stop offset="1" stopColor="#E2341D" />
                </linearGradient>
            </defs>
        </svg>
    );
}

function Planner({
    icon,
    title,
    ready,
    running,
    onRun,
    onView,
}: {
    icon: GlyphName;
    title: string;
    ready: number | null;
    running: boolean;
    onRun: () => void;
    onView: () => void;
}) {
    return (
        <div className={styles.planner} data-running={running}>
            <span className={panel.itemIcon} data-tone={ready ? 'ink' : undefined}>
                <Icon name={icon} size={16} />
            </span>
            <span className={panel.itemText}>
                <strong>{title}</strong>
                <span>
                    {running ? 'Planning…' : ready ? `Ready ${ago(ready)}` : 'Not run yet'}
                    {ready && !running ? (
                        <button type="button" className={styles.view} onClick={onView}>
                            Show on map
                        </button>
                    ) : null}
                </span>
            </span>
            {ready ? (
                <IconButton
                    icon="refresh"
                    label="Run again"
                    className={styles.rerun}
                    disabled={running}
                    onClick={onRun}
                />
            ) : (
                <Button size="sm" variant="soft" loading={running} onClick={onRun} icon="play">
                    Run
                </Button>
            )}
            {running ? <span className={styles.shimmer} /> : null}
        </div>
    );
}

export function OperatorPanel({ zone }: { zone: WatchZone }) {
    useTick(1000);
    const setSchedule = useZones((s) => s.setSchedule);
    const clearPending = useZones((s) => s.clearPending);
    const select = useUi((s) => s.select);
    const setSuggestions = useUi((s) => s.setSuggestions);
    const setMode = useUi((s) => s.setMode);
    const [deploying, setDeploying] = useState(false);

    const step = setupStep(zone);
    const deployed = zone.servers.filter((s) => s.status === 'deployed');
    const pending = zone.servers.filter((s) => s.status === 'pending');
    const coverage = deployed.length ? deployedCoverage(zone) : 0;
    const projected = pending.length ? computeCoverage(zone.grid, zone.servers).pct : coverage;
    const airborne = zone.drones.filter((d) => {
        const s = getTelemetry(d.id)?.state;
        return s === 'scanning' || s === 'launching' || s === 'returning';
    }).length;
    const { mapped, atRisk, onFire } = riskCounts(zone);
    const newReports = zone.reports.filter((r) => r.status === 'new');

    const scan = () => {
        const problem = startScan(zone.id);
        if (problem) notify('warning', 'Scan not started', problem, zone);
        else setMode('detection');
    };

    const plan = (kind: 'civilian' | 'responder') => {
        void runPlanner(zone.id, kind).then(() => setSuggestions(true));
    };

    return (
        <motion.aside
            className={`${panel.panel} ${styles.panel}`}
            initial={{ opacity: 0, x: -36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -36 }}
            transition={{ type: 'spring', stiffness: 260, damping: 30, delay: 0.05 }}
        >
            <AnimatePresence>
                {step ? (
                    <motion.div
                        className={panel.section}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                    >
                        <div className={panel.callout} data-tone="ink">
                            <Icon name={step === 2 ? 'server' : 'drone'} size={18} />
                            <span style={{ flex: 1 }}>
                                <strong>Finish setting up</strong>
                                {step === 2
                                    ? 'Place edge servers so drones have a network.'
                                    : 'Pair drones with your edge servers.'}
                            </span>
                        </div>
                        <Button
                            variant="primary"
                            block
                            iconAfter="arrowRight"
                            style={{ marginTop: 10 }}
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
                    </motion.div>
                ) : null}
            </AnimatePresence>

            <div className={panel.section}>
                <div className={styles.metrics}>
                    <div className={styles.coverage}>
                        <CoverageRing pct={coverage} />
                        <div>
                            <span className={panel.muted}>Coverage</span>
                            <strong
                                className={styles.metricValue}
                                data-low={deployed.length > 0 && coverage < 90}
                            >
                                <CountUp value={coverage} decimals={1} suffix="%" />
                            </strong>
                        </div>
                    </div>
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
                            {airborne ? <span className={styles.airborne}>{airborne}</span> : null}
                            {airborne ? '/' : ''}
                            {zone.drones.length}
                        </strong>
                        <span className={panel.muted}>{airborne ? 'airborne' : 'docked'}</span>
                    </button>
                    <div className={styles.metric}>
                        <span className={panel.muted}>Mapped</span>
                        <strong className={styles.metricValue}>
                            {Math.round((100 * mapped) / Math.max(1, zone.grid.inZoneCount))}%
                        </strong>
                        <span className={panel.muted}>
                            {onFire
                                ? `${onFire} ha fire`
                                : atRisk
                                  ? `${atRisk} ha at risk`
                                  : 'no risk'}
                        </span>
                    </div>
                </div>

                <AnimatePresence>
                    {deployed.length > 0 && (coverage < 90 || pending.length > 0) ? (
                        <motion.div
                            className={panel.callout}
                            data-tone="pink"
                            style={{ marginTop: 14, flexDirection: 'column' }}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                        >
                            <span>
                                <strong>
                                    {pending.length
                                        ? `${pending.length} placements suggested`
                                        : `Coverage is below 90%`}
                                </strong>
                                {pending.length
                                    ? `They lift coverage to ${projected}%. Pending sites flash on the map.`
                                    : 'Some of the forest is outside every edge server radius.'}
                            </span>
                            <span className={panel.row}>
                                {pending.length ? (
                                    <>
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            icon="server"
                                            loading={deploying}
                                            onClick={async () => {
                                                setDeploying(true);
                                                await deployPending(zone.id);
                                                setDeploying(false);
                                            }}
                                        >
                                            Deploy {pending.length}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={deploying}
                                            onClick={() => clearPending(zone.id)}
                                        >
                                            Dismiss
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        icon="sparkle"
                                        onClick={() => {
                                            setMode('operator');
                                            suggestPlacements(zone.id);
                                        }}
                                    >
                                        Suggest placements
                                    </Button>
                                )}
                            </span>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="radar" size={13} /> Fleet scan
                    </span>
                    <span className={panel.muted}>Last {ago(zone.lastScanAt)}</span>
                </div>
                {zone.scan ? (
                    <div className={styles.scanLive}>
                        <div className={panel.row} style={{ justifyContent: 'space-between' }}>
                            <span className={styles.liveLabel}>
                                <span className={styles.liveDot} /> Scanning{' '}
                                {Math.round(zone.scan.progress * 100)}%
                            </span>
                            <Button size="sm" icon="stop" onClick={() => stopScan(zone.id)}>
                                Stop
                            </Button>
                        </div>
                        <div className={panel.bar} style={{ marginTop: 10 }}>
                            <motion.span
                                className={panel.barFill}
                                animate={{ width: `${zone.scan.progress * 100}%` }}
                                transition={{ duration: 0.2 }}
                            />
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="primary"
                        block
                        icon="play"
                        disabled={Boolean(step)}
                        onClick={scan}
                    >
                        Run scan now
                    </Button>
                )}
                <div className={styles.schedule}>
                    <div className={panel.row} style={{ justifyContent: 'space-between' }}>
                        <span>
                            <strong>Repeat scan</strong>
                            <span className={panel.muted}>
                                {zone.schedule.enabled
                                    ? ` · next ${until(zone.schedule.nextAt)}`
                                    : ' · off'}
                            </span>
                        </span>
                        <Toggle
                            on={zone.schedule.enabled}
                            onChange={(enabled) => setSchedule(zone.id, { enabled })}
                            label="Repeat scan"
                            disabled={Boolean(step)}
                        />
                    </div>
                    <AnimatePresence initial={false}>
                        {zone.schedule.enabled ? (
                            <motion.div
                                className={styles.intervals}
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                            >
                                <span className={panel.muted}>Every</span>
                                {INTERVALS.map((h) => (
                                    <button
                                        key={h}
                                        type="button"
                                        data-active={zone.schedule.everyHours === h}
                                        onClick={() => setSchedule(zone.id, { everyHours: h })}
                                    >
                                        {h}h
                                    </button>
                                ))}
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="route" size={13} /> Path planners
                    </span>
                </div>
                <div className={panel.stack}>
                    <Planner
                        icon="users"
                        title="Civilian path plan"
                        ready={zone.civilianPlan?.generatedAt ?? null}
                        running={zone.planning.civilian}
                        onRun={() => plan('civilian')}
                        onView={() => setSuggestions(true)}
                    />
                    <Planner
                        icon="shield"
                        title="Responder path plan"
                        ready={zone.responderPlan?.generatedAt ?? null}
                        running={zone.planning.responder}
                        onRun={() => plan('responder')}
                        onView={() => setSuggestions(true)}
                    />
                </div>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="users" size={13} /> Civilians
                    </span>
                    {zone.checkIns.total ? (
                        <span className={panel.muted}>
                            {zone.checkIns.safe}/{zone.checkIns.total} SAFE
                        </span>
                    ) : null}
                </div>
                {zone.checkIns.total ? (
                    <div className={panel.bar} style={{ marginBottom: 12 }}>
                        <motion.span
                            className={panel.barFill}
                            data-tone="ok"
                            initial={{ width: 0 }}
                            animate={{
                                width: `${(100 * zone.checkIns.safe) / zone.checkIns.total}%`,
                            }}
                            transition={{ type: 'spring', stiffness: 80, damping: 20 }}
                        />
                    </div>
                ) : (
                    <p className={panel.muted} style={{ marginBottom: 10 }}>
                        No civilians subscribed yet. They join by texting the Ember number.
                    </p>
                )}
                <ul className={panel.list}>
                    {newReports.map((r) => (
                        <li key={r.id}>
                            <button
                                type="button"
                                className={panel.item}
                                onClick={() => select({ kind: 'report', id: r.id })}
                            >
                                <span className={panel.itemIcon} data-tone="flame">
                                    <Icon name="camera" size={15} />
                                </span>
                                <span className={panel.itemText}>
                                    <strong>{r.text}</strong>
                                    <span>
                                        {r.from} · {ago(r.receivedAt)}
                                    </span>
                                </span>
                                <span className={panel.tag} data-tone="flame">
                                    Verify
                                </span>
                            </button>
                        </li>
                    ))}
                    {newReports.length === 0 ? (
                        <li className={panel.muted}>No civilian reports waiting.</li>
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
                    icon="drone"
                    disabled={!deployed.length}
                    onClick={() => navigate({ name: 'setup', zoneId: zone.id, step: 'drones' })}
                >
                    Pair drones
                </Button>
            </div>
        </motion.aside>
    );
}
