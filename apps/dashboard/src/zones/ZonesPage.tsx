import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { AccountMenu } from '../chrome/AccountMenu';
import { NotificationsMenu } from '../chrome/NotificationsMenu';
import { Icon } from '../icons/Icon';
import { Wordmark } from '../icons/Logo';
import type { ZoneStatus } from '../model/types';
import { areaKm2, summaryStatus } from '../model/zone';
import { navigate } from '../store/router';
import { useZoneList } from '../store/sync';
import { useZones } from '../store/zones';
import { Button } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { QUICK, SMOOTH, SNAP } from '../ui/motion';
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

export function ZonesPage() {
    useZoneList();
    const summaries = useZones((s) => s.summaries);
    const listError = useZones((s) => s.listError);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');

    const all = useMemo(() => summaries ?? [], [summaries]);
    const counts = useMemo(() => {
        const c: Record<Filter, number> = {
            all: all.length,
            on_fire: 0,
            at_risk: 0,
            healthy: 0,
            awaiting: 0,
            setup: 0,
        };
        for (const z of all) c[summaryStatus(z)] += 1;
        return c;
    }, [all]);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return all
            .filter(
                (z) =>
                    filter === 'all' ||
                    summaryStatus(z) === filter ||
                    (filter === 'healthy' && summaryStatus(z) === 'awaiting'),
            )
            .filter(
                (z) =>
                    !q ||
                    z.name.toLowerCase().includes(q) ||
                    (z.region ?? '').toLowerCase().includes(q),
            )
            .sort((a, b) => RANK[summaryStatus(a)] - RANK[summaryStatus(b)]);
    }, [all, filter, query]);

    const drones = all.reduce((s, z) => s + z.summary.drones, 0);
    const scanning = all.filter((z) =>
        ['starting', 'mapping', 'stopping'].includes(z.summary.lastScan?.state ?? ''),
    ).length;
    const watchedKm2 = all.reduce((s, z) => s + areaKm2(z.boundary), 0);

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
                <div className={styles.masthead}>
                    <h1 className={styles.title}>Watch zones</h1>
                    <Button variant="primary" icon="plus" onClick={() => navigate({ name: 'new' })}>
                        New watch zone
                    </Button>
                </div>

                <dl className={styles.stats}>
                    <div data-tone={counts.on_fire ? 'fire' : undefined}>
                        <dt>Active fires</dt>
                        <dd>
                            <CountUp value={counts.on_fire} />
                        </dd>
                    </div>
                    <div data-tone={counts.at_risk ? 'risk' : undefined}>
                        <dt>Zones at risk</dt>
                        <dd>
                            <CountUp value={counts.at_risk} />
                        </dd>
                    </div>
                    <div>
                        <dt>
                            {scanning
                                ? `Drones, ${scanning} zone${scanning === 1 ? '' : 's'} scanning`
                                : 'Drones'}
                        </dt>
                        <dd>
                            <CountUp value={drones} />
                        </dd>
                    </div>
                    <div>
                        <dt>km² watched</dt>
                        <dd>
                            <CountUp value={watchedKm2} decimals={1} />
                        </dd>
                    </div>
                </dl>

                <div className={styles.controls}>
                    <Segmented<Filter>
                        variant="tabs"
                        label="Filter by status"
                        value={filter}
                        onChange={setFilter}
                        options={FILTERS.map((f) => ({ ...f, count: counts[f.value] }))}
                    />
                    <label className={styles.search}>
                        <Icon name="search" size={14} />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search"
                            aria-label="Search watch zones"
                        />
                        <AnimatePresence>
                            {query ? (
                                <motion.button
                                    type="button"
                                    aria-label="Clear search"
                                    onClick={() => setQuery('')}
                                    initial={{ opacity: 0, scale: 0.6 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.6 }}
                                    transition={QUICK}
                                >
                                    <Icon name="close" size={10} />
                                </motion.button>
                            ) : null}
                        </AnimatePresence>
                    </label>
                </div>

                <div className={styles.grid}>
                    <AnimatePresence mode="popLayout" initial={false}>
                        {shown.map((zone) => (
                            <motion.div
                                key={zone.id}
                                layout
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.98, transition: QUICK }}
                                transition={{ ...SMOOTH, layout: SNAP }}
                            >
                                <ZoneCard zone={zone} />
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>

                <AnimatePresence>
                    {(shown.length === 0 && summaries !== null) ||
                    (summaries === null && listError) ? (
                        <motion.div
                            className={styles.emptyState}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, transition: QUICK }}
                            transition={SMOOTH}
                        >
                            <strong>
                                {summaries === null
                                    ? 'Watch zones did not load'
                                    : all.length
                                      ? 'No watch zones match'
                                      : 'No watch zones yet'}
                            </strong>
                            {summaries === null ? <span>{listError}</span> : null}
                            {all.length ? (
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        setQuery('');
                                        setFilter('all');
                                    }}
                                >
                                    Show all zones
                                </Button>
                            ) : null}
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </main>
        </div>
    );
}
