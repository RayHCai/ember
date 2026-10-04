import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon';
import { deployPending, suggestPlacements } from '../sim/actions';
import { computeCoverage } from '../sim/geo';
import type { WatchZone } from '../sim/types';
import { navigate } from '../store/router';
import { useZones } from '../store/zones';
import { Button } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import panel from '../ui/panel.module.css';
import styles from './Setup.module.css';

const ANALYSIS = [
    'Reading terrain and canopy height',
    'Checking line of sight between sites',
    'Favoring sites near roads for upkeep',
    'Balancing coverage against hardware',
];

export function ServersStep({ zone }: { zone: WatchZone }) {
    const clearPending = useZones((s) => s.clearPending);
    const [processing, setProcessing] = useState(false);
    const [phase, setPhase] = useState(0);
    const [deploying, setDeploying] = useState(false);
    const pending = zone.servers.filter((s) => s.status === 'pending');
    const deployed = zone.servers.filter((s) => s.status === 'deployed');
    const live = computeCoverage(zone.grid, deployed).pct;
    const projected = computeCoverage(zone.grid, zone.servers).pct;
    const shown = pending.length ? projected : live;

    useEffect(() => {
        if (!processing) return;
        const timer = window.setInterval(() => setPhase((p) => (p + 1) % ANALYSIS.length), 420);
        return () => window.clearInterval(timer);
    }, [processing]);

    const process = () => {
        setProcessing(true);
        setPhase(0);
        window.setTimeout(() => {
            suggestPlacements(zone.id);
            setProcessing(false);
        }, 1700);
    };

    const deploy = async () => {
        setDeploying(true);
        await deployPending(zone.id);
        setDeploying(false);
    };

    return (
        <div className={styles.stepBody}>
            <p className={panel.lead}>
                Edge servers form the local network drones fly on. Each one reaches about 1.5 km, so
                a zone needs several. Ember suggests sites that keep coverage above 90%.
            </p>

            <div className={styles.coverage}>
                <div
                    className={panel.row}
                    style={{ alignItems: 'baseline', justifyContent: 'space-between' }}
                >
                    <span className={panel.sectionTitle}>
                        {pending.length ? 'Projected coverage' : 'Coverage'}
                    </span>
                    <span className={panel.big} data-low={shown < 90}>
                        <CountUp value={shown} decimals={1} suffix="%" />
                    </span>
                </div>
                <div className={panel.bar} style={{ marginTop: 22 }}>
                    <motion.span
                        className={panel.barFill}
                        data-tone={shown >= 90 ? 'ok' : undefined}
                        initial={false}
                        animate={{ width: `${shown}%` }}
                        transition={{ type: 'spring', stiffness: 120, damping: 22 }}
                    />
                    <span
                        className={panel.barMark}
                        style={{ left: '90%' }}
                        data-label="Target 90%"
                    />
                </div>
                <p className={panel.muted} style={{ marginTop: 10 }}>
                    {deployed.length} deployed
                    {pending.length ? `, ${pending.length} suggested` : ''} · {zone.areaKm2} km²
                    zone
                </p>
            </div>

            <AnimatePresence mode="wait">
                {processing ? (
                    <motion.div
                        key="processing"
                        className={styles.processing}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                    >
                        <span className={styles.processingRing}>
                            <Icon name="radar" size={20} />
                        </span>
                        <span>
                            <strong>Finding the best sites</strong>
                            <AnimatePresence mode="wait">
                                <motion.span
                                    key={phase}
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                >
                                    {ANALYSIS[phase]}
                                </motion.span>
                            </AnimatePresence>
                        </span>
                    </motion.div>
                ) : zone.servers.length ? (
                    <motion.ul
                        key="list"
                        className={panel.list}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                    >
                        <AnimatePresence initial={false}>
                            {zone.servers.map((s, i) => (
                                <motion.li
                                    key={s.id}
                                    className={panel.item}
                                    layout
                                    initial={{ opacity: 0, x: -12 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: 12 }}
                                    transition={{
                                        delay: i * 0.05,
                                        type: 'spring',
                                        stiffness: 380,
                                        damping: 30,
                                    }}
                                >
                                    <span
                                        className={panel.itemIcon}
                                        data-tone={s.status === 'pending' ? 'pink' : 'ink'}
                                    >
                                        <Icon name="server" size={16} />
                                    </span>
                                    <span className={panel.itemText}>
                                        <strong>Edge server {s.name}</strong>
                                        <span className="mono">
                                            {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
                                        </span>
                                    </span>
                                    <AnimatePresence mode="wait" initial={false}>
                                        <motion.span
                                            key={s.status}
                                            className={panel.tag}
                                            data-tone={s.status === 'pending' ? 'pink' : 'ok'}
                                            initial={{ scale: 0.6, opacity: 0 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            exit={{ scale: 0.6, opacity: 0 }}
                                        >
                                            {s.status === 'pending' ? (
                                                'Suggested'
                                            ) : (
                                                <>
                                                    <Icon name="check" size={10} /> Connected
                                                </>
                                            )}
                                        </motion.span>
                                    </AnimatePresence>
                                </motion.li>
                            ))}
                        </AnimatePresence>
                    </motion.ul>
                ) : null}
            </AnimatePresence>

            {pending.length ? (
                <p className={panel.muted}>
                    <Icon name="info" size={12} /> Drag a flashing server on the map to fine-tune
                    its site.
                </p>
            ) : null}

            <div className={styles.footer}>
                {pending.length ? (
                    <>
                        <Button
                            variant="primary"
                            size="lg"
                            block
                            icon="server"
                            loading={deploying}
                            onClick={deploy}
                        >
                            {deploying
                                ? 'Connecting servers'
                                : `Deploy ${pending.length} server${pending.length === 1 ? '' : 's'}`}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            block
                            disabled={deploying}
                            onClick={() => clearPending(zone.id)}
                        >
                            Discard suggestions
                        </Button>
                    </>
                ) : deployed.length && live >= 90 ? (
                    <Button
                        variant="primary"
                        size="lg"
                        block
                        iconAfter="arrowRight"
                        onClick={() =>
                            navigate({ name: 'setup', zoneId: zone.id, step: 'drones' }, true)
                        }
                    >
                        Continue to drones
                    </Button>
                ) : (
                    <Button
                        variant="primary"
                        size="lg"
                        block
                        icon="radar"
                        loading={processing}
                        onClick={process}
                    >
                        {deployed.length ? 'Suggest more placements' : 'Process'}
                    </Button>
                )}
                {!pending.length && deployed.length && live < 90 ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        block
                        onClick={() =>
                            navigate({ name: 'setup', zoneId: zone.id, step: 'drones' }, true)
                        }
                    >
                        Continue with {live}% coverage
                    </Button>
                ) : null}
                {!deployed.length && !pending.length && !processing ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        block
                        onClick={() => navigate({ name: 'zone', zoneId: zone.id })}
                    >
                        Skip for now
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
