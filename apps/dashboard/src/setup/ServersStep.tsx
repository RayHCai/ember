import type { EdgeServer } from '@ember/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../icons/Icon';
import { computeCoverage } from '../model/geo';
import type { ServerView, ZoneView } from '../model/types';
import { deployed as deployedOf } from '../model/zone';
import {
    assignPlacement,
    clearPlacements,
    removePlacement,
    suggestPlacements,
} from '../store/actions';
import { navigate } from '../store/router';
import { useZones } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { QUICK, SMOOTH, SNAP } from '../ui/motion';
import panel from '../ui/panel.module.css';
import { Segmented } from '../ui/Segmented';
import { Spinner } from '../ui/Spinner';
import ui from '../ui/ui.module.css';
import styles from './Setup.module.css';

const RADII = [300, 500, 1000, 1500];

function radiusLabel(m: number): string {
    return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

/** Registered connectors waiting for a site, online ones first. */
function waiting(unassigned: EdgeServer[]): EdgeServer[] {
    return [...unassigned].sort(
        (a, b) => Number(b.live?.online ?? false) - Number(a.live?.online ?? false),
    );
}

function Assign({
    zoneId,
    site,
    options,
}: {
    zoneId: string;
    site: ServerView;
    options: EdgeServer[];
}) {
    const [busy, setBusy] = useState(false);
    if (options.length === 0)
        return (
            <span className={panel.tag} data-tone="pink">
                Planned
            </span>
        );
    return (
        <select
            className={`${ui.input} ${styles.assign}`}
            aria-label={`Assign an edge server to ${site.name}`}
            value=""
            disabled={busy}
            onChange={async (e) => {
                if (!e.target.value) return;
                setBusy(true);
                await assignPlacement(zoneId, site.id, e.target.value);
                setBusy(false);
            }}
        >
            <option value="">Assign…</option>
            {options.map((o) => (
                <option key={o.edgeServerId} value={o.edgeServerId}>
                    {o.edgeServerId}
                    {o.live?.online ? '' : ' (offline)'}
                </option>
            ))}
        </select>
    );
}

interface Props {
    zone: ZoneView;
    radiusM: number;
    setRadiusM: (m: number) => void;
    pinpointing: boolean;
    setPinpointing: (on: boolean) => void;
}

export function ServersStep({ zone, radiusM, setRadiusM, pinpointing, setPinpointing }: Props) {
    const unassigned = waiting(useZones((s) => s.unassigned));
    const [processing, setProcessing] = useState(false);
    const pending = zone.servers.filter((s) => s.status === 'pending');
    const deployed = deployedOf(zone);
    const live = deployed.length ? computeCoverage(zone.grid, deployed).pct : 0;
    const projected = computeCoverage(zone.grid, zone.servers).pct;
    const shown = pending.length ? projected : live;

    const suggest = async () => {
        setProcessing(true);
        setPinpointing(false);
        await suggestPlacements(zone.id, radiusM);
        setProcessing(false);
    };

    return (
        <div className={styles.stepBody}>
            <div className={styles.coverage}>
                <div className={styles.coverageHead}>
                    <span className={panel.sectionTitle}>
                        {pending.length ? 'Projected coverage' : 'Coverage'}
                    </span>
                    <span className={panel.big} data-low={shown < 90}>
                        <CountUp value={shown} decimals={1} suffix="%" />
                    </span>
                </div>
                <div className={panel.bar} style={{ marginTop: 12 }}>
                    <motion.span
                        className={panel.barFill}
                        data-tone={shown >= 90 ? 'ok' : undefined}
                        initial={false}
                        animate={{ width: `${shown}%` }}
                        transition={SMOOTH}
                    />
                    <span className={panel.barMark} style={{ left: '90%' }} data-label="90%" />
                </div>
                <p className={panel.muted} style={{ marginTop: 10 }}>
                    {deployed.length} deployed
                    {pending.length ? `, ${pending.length} planned` : ''} · {zone.areaKm2} km²
                </p>
            </div>

            <div className={ui.field}>
                <span className={ui.fieldLabel}>Connectivity radius</span>
                <Segmented<string>
                    label="Connectivity radius"
                    value={String(radiusM)}
                    onChange={(v) => setRadiusM(Number(v))}
                    options={RADII.map((r) => ({ value: String(r), label: radiusLabel(r) }))}
                />
            </div>

            <AnimatePresence mode="wait">
                {processing ? (
                    <motion.div
                        key="processing"
                        className={styles.processing}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={QUICK}
                    >
                        <Spinner size={16} />
                        <span>
                            <strong>Finding the best sites</strong>
                        </span>
                    </motion.div>
                ) : zone.servers.length ? (
                    <motion.ul
                        key="list"
                        className={panel.list}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={QUICK}
                    >
                        <AnimatePresence initial={false}>
                            {zone.servers.map((s, i) => (
                                <motion.li
                                    key={s.id}
                                    className={panel.item}
                                    layout
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ ...SMOOTH, delay: i * 0.03, layout: SNAP }}
                                >
                                    <span
                                        className={panel.itemIcon}
                                        data-tone={s.status === 'pending' ? 'pink' : 'ink'}
                                    >
                                        <Icon name="server" size={15} />
                                    </span>
                                    <span className={panel.itemText}>
                                        <strong>Edge server {s.name}</strong>
                                        <span className="mono">
                                            {s.lat.toFixed(4)}, {s.lon.toFixed(4)} ·{' '}
                                            {radiusLabel(s.radiusM)}
                                        </span>
                                    </span>
                                    {s.status === 'pending' ? (
                                        <>
                                            <Assign
                                                zoneId={zone.id}
                                                site={s}
                                                options={unassigned}
                                            />
                                            <IconButton
                                                icon="trash"
                                                label="Remove site"
                                                onClick={() => void removePlacement(zone.id, s.id)}
                                            />
                                        </>
                                    ) : (
                                        <span
                                            className={panel.tag}
                                            data-tone={s.online ? 'ok' : undefined}
                                        >
                                            {s.online ? (
                                                <>
                                                    <Icon name="check" size={10} /> Connected
                                                </>
                                            ) : s.online === false ? (
                                                'Offline'
                                            ) : (
                                                'Unknown'
                                            )}
                                        </span>
                                    )}
                                </motion.li>
                            ))}
                        </AnimatePresence>
                    </motion.ul>
                ) : null}
            </AnimatePresence>

            <div
                className={`${panel.callout} ${styles.waiting}`}
                data-tone={unassigned.length ? 'pink' : undefined}
            >
                <span>
                    <strong>
                        {unassigned.length
                            ? `${unassigned.length} edge server${unassigned.length === 1 ? '' : 's'} waiting for a site`
                            : 'No edge servers waiting'}
                    </strong>
                    {unassigned.length ? (
                        <span className="mono">
                            {unassigned
                                .slice(0, 3)
                                .map((e) => e.edgeServerId)
                                .join(', ')}
                            {unassigned.length > 3 ? ` +${unassigned.length - 3}` : ''}
                        </span>
                    ) : (
                        <span>Power one on near a planned site.</span>
                    )}
                </span>
            </div>

            {pending.length ? (
                <p className={panel.muted}>Drag a flashing site on the map to move it.</p>
            ) : null}

            <div className={styles.footer}>
                <div className={panel.row}>
                    <Button
                        variant={deployed.length || pending.length ? 'secondary' : 'primary'}
                        size="sm"
                        icon="sparkle"
                        loading={processing}
                        onClick={() => void suggest()}
                    >
                        {pending.length || deployed.length ? 'Suggest again' : 'Suggest placements'}
                    </Button>
                    <Button
                        variant={pinpointing ? 'primary' : 'secondary'}
                        size="sm"
                        icon="pin"
                        onClick={() => setPinpointing(!pinpointing)}
                    >
                        {pinpointing ? 'Click the map' : 'Pinpoint a site'}
                    </Button>
                    {pending.length ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void clearPlacements(zone.id)}
                        >
                            Clear
                        </Button>
                    ) : null}
                </div>
                {deployed.length ? (
                    <Button
                        variant="primary"
                        size="lg"
                        block
                        iconAfter="arrowRight"
                        onClick={() =>
                            navigate({ name: 'setup', zoneId: zone.id, step: 'drones' }, true)
                        }
                    >
                        {live >= 90 ? 'Continue to drones' : `Continue with ${live}% coverage`}
                    </Button>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        block
                        onClick={() => navigate({ name: 'zone', zoneId: zone.id })}
                    >
                        Skip for now
                    </Button>
                )}
            </div>
        </div>
    );
}
