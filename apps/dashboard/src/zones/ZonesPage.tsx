import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { AccountMenu } from '../chrome/AccountMenu';
import { NotificationsMenu } from '../chrome/NotificationsMenu';
import { Icon } from '../icons/Icon';
import { Logo, Wordmark } from '../icons/Logo';
import { getTelemetry } from '../sim/live';
import type { ZoneStatus } from '../sim/types';
import { zoneStatus } from '../sim/world';
import { navigate } from '../store/router';
import { useSession } from '../store/session';
import { useZones } from '../store/zones';
import { Button } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { Segmented } from '../ui/Segmented';
import { ZoneCard } from './ZoneCard';
import styles from './ZonesPage.module.css';

type Filter = 'all' | ZoneStatus;

const FILTERS: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'on_fire', label: 'Active fire' },
    { value: 'at_risk', label: 'At risk' },
    { value: 'healthy', label: 'Healthy' },
    { value: 'setup', label: 'Setup' },
];

const RANK: Record<ZoneStatus, number> = {
    on_fire: 0,
    at_risk: 1,
    healthy: 2,
    awaiting: 3,
    setup: 4,
};

function greeting(): string {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function ZonesPage() {
    const zones = useZones((s) => s.zones);
    const order = useZones((s) => s.order);
    const name = useSession((s) => s.session?.name ?? '');
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');

    const all = useMemo(() => order.map((id) => zones[id]!).filter(Boolean), [order, zones]);
    const counts = useMemo(() => {
        const c: Record<Filter, number> = {
            all: all.length,
            on_fire: 0,
            at_risk: 0,
            healthy: 0,
            awaiting: 0,
            setup: 0,
        };
        for (const z of all) c[zoneStatus(z)] += 1;
        return c;
    }, [all]);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return all
            .filter(
                (z) =>
                    filter === 'all' ||
                    zoneStatus(z) === filter ||
                    (filter === 'healthy' && zoneStatus(z) === 'awaiting'),
            )
            .filter(
                (z) => !q || z.name.toLowerCase().includes(q) || z.region.toLowerCase().includes(q),
            )
            .sort((a, b) => RANK[zoneStatus(a)] - RANK[zoneStatus(b)]);
    }, [all, filter, query]);

    const drones = all.reduce((s, z) => s + z.drones.length, 0);
    const airborne = all.reduce(
        (s, z) =>
            s +
            z.drones.filter((d) =>
                ['scanning', 'launching', 'returning'].includes(getTelemetry(d.id)?.state ?? ''),
            ).length,
        0,
    );
    const acres = all.reduce((s, z) => s + z.areaKm2, 0);

    return (
        <div className={styles.page}>
            <header className={styles.top}>
                <Wordmark />
                <div className={styles.topRight}>
                    <NotificationsMenu />
                    <AccountMenu />
                </div>
            </header>

            <main className={styles.main}>
                <motion.section
                    className={styles.intro}
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                >
                    <div>
                        <p className={styles.eyebrow}>
                            {greeting()}
                            {name ? `, ${name.split(' ')[0]}` : ''}
                        </p>
                        <h1 className={styles.title}>Watch zones</h1>
                    </div>
                    <div className={styles.stats}>
                        <div
                            className={styles.stat}
                            data-tone={counts.on_fire ? 'fire' : undefined}
                        >
                            <strong>
                                <CountUp value={counts.on_fire} />
                            </strong>
                            <span>Active fires</span>
                        </div>
                        <div
                            className={styles.stat}
                            data-tone={counts.at_risk ? 'risk' : undefined}
                        >
                            <strong>
                                <CountUp value={counts.at_risk} />
                            </strong>
                            <span>Zones at risk</span>
                        </div>
                        <div className={styles.stat}>
                            <strong>
                                <CountUp value={drones} />
                            </strong>
                            <span>
                                {airborne ? `${airborne} drones airborne` : 'Drones paired'}
                            </span>
                        </div>
                        <div className={styles.stat}>
                            <strong>
                                <CountUp value={acres} decimals={1} />
                            </strong>
                            <span>km² watched</span>
                        </div>
                    </div>
                </motion.section>

                <motion.div
                    className={styles.controls}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08, duration: 0.5 }}
                >
                    <label className={styles.search}>
                        <Icon name="search" size={16} />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search by name or region"
                            aria-label="Search watch zones"
                        />
                        {query ? (
                            <button
                                type="button"
                                aria-label="Clear search"
                                onClick={() => setQuery('')}
                            >
                                <Icon name="close" size={12} />
                            </button>
                        ) : null}
                    </label>
                    <Segmented<Filter>
                        label="Filter by status"
                        value={filter}
                        onChange={setFilter}
                        options={FILTERS.map((f) => ({
                            value: f.value,
                            label: `${f.label} ${counts[f.value] ? counts[f.value] : ''}`.trim(),
                        }))}
                    />
                    <Button
                        variant="primary"
                        icon="plus"
                        className={styles.newButton}
                        onClick={() => navigate({ name: 'new' })}
                    >
                        New watch zone
                    </Button>
                </motion.div>

                <motion.div className={styles.grid} layout>
                    <AnimatePresence mode="popLayout">
                        {shown.map((zone, i) => (
                            <motion.div
                                key={zone.id}
                                layout
                                initial={{ opacity: 0, y: 24, scale: 0.97 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
                                transition={{
                                    type: 'spring',
                                    stiffness: 260,
                                    damping: 26,
                                    delay: 0.12 + i * 0.05,
                                }}
                            >
                                <ZoneCard zone={zone} />
                            </motion.div>
                        ))}
                        {filter === 'all' && !query ? (
                            <motion.button
                                key="new"
                                layout
                                type="button"
                                className={styles.newCard}
                                onClick={() => navigate({ name: 'new' })}
                                initial={{ opacity: 0, y: 24 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                transition={{
                                    type: 'spring',
                                    stiffness: 260,
                                    damping: 26,
                                    delay: 0.12 + shown.length * 0.05,
                                }}
                            >
                                <span className={styles.newIcon}>
                                    <Icon name="plus" size={22} />
                                </span>
                                <strong>New watch zone</strong>
                                <span>
                                    Draw a forest boundary, place edge servers, pair drones.
                                </span>
                            </motion.button>
                        ) : null}
                    </AnimatePresence>
                </motion.div>

                <AnimatePresence>
                    {shown.length === 0 ? (
                        <motion.div
                            className={styles.emptyState}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                        >
                            <Logo size={44} />
                            <strong>No watch zones match</strong>
                            <span>Try another name or clear the filter.</span>
                            <Button
                                size="sm"
                                onClick={() => {
                                    setQuery('');
                                    setFilter('all');
                                }}
                            >
                                Show all zones
                            </Button>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </main>
        </div>
    );
}
