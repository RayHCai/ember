import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import { getTelemetry, MODE_LABEL } from '../live/telemetry';
import type { ZoneView } from '../model/types';
import { deployed as deployedOf } from '../model/zone';
import { navigate } from '../store/router';
import { Button } from '../ui/Button';
import { SMOOTH, SNAP } from '../ui/motion';
import panel from '../ui/panel.module.css';
import { useNow } from '../ui/useNow';
import styles from './Setup.module.css';

/** Drones pair by joining an edge server's network; this step watches them arrive. */
export function DronesStep({ zone }: { zone: ZoneView }) {
    useNow(1000);
    const servers = deployedOf(zone);
    const online = servers.filter((s) => s.online).length;

    if (servers.length === 0) {
        return (
            <div className={styles.stepBody}>
                <p className={panel.muted}>Drones pair with a deployed edge server.</p>
                <Button
                    variant="primary"
                    block
                    onClick={() =>
                        navigate({ name: 'setup', zoneId: zone.id, step: 'servers' }, true)
                    }
                >
                    Place edge servers
                </Button>
            </div>
        );
    }

    return (
        <div className={styles.stepBody}>
            <div className={styles.pairCard} data-active>
                <span className={styles.radar}>
                    <span />
                    <span />
                    <Icon name="drone" size={18} />
                </span>
                <span>
                    <strong>Listening for drones</strong>
                    <span className={panel.muted}>
                        {zone.drones.length} paired · {online} of {servers.length} edge servers
                        online
                    </span>
                </span>
            </div>

            <ul className={panel.list}>
                <AnimatePresence initial={false}>
                    {zone.drones.map((d) => {
                        const server = zone.servers.find((s) => s.id === d.serverId);
                        const t = getTelemetry(d.id);
                        return (
                            <motion.li
                                key={d.id}
                                className={panel.item}
                                layout
                                initial={{ opacity: 0, y: -6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ ...SMOOTH, layout: SNAP }}
                            >
                                <span className={panel.itemIcon}>
                                    <Icon name="drone" size={15} />
                                </span>
                                <span className={panel.itemText}>
                                    <strong>{d.name}</strong>
                                    <span className="mono">{d.id}</span>
                                </span>
                                <span className={panel.tag} data-tone={t ? 'ok' : undefined}>
                                    {server?.name ?? 'No server'}
                                    {t
                                        ? ` · ${MODE_LABEL[t.mode]} · ${Math.round(t.batteryPct)}%`
                                        : ''}
                                </span>
                            </motion.li>
                        );
                    })}
                </AnimatePresence>
                {zone.drones.length === 0 ? (
                    <li className={panel.muted}>Power on a drone near an edge server.</li>
                ) : null}
            </ul>

            <div className={styles.footer}>
                <Button
                    variant={zone.drones.length ? 'primary' : 'ghost'}
                    size={zone.drones.length ? 'lg' : 'sm'}
                    block
                    iconAfter="arrowRight"
                    onClick={() => navigate({ name: 'zone', zoneId: zone.id })}
                >
                    {zone.drones.length ? 'Finish and open zone' : 'Skip for now'}
                </Button>
            </div>
        </div>
    );
}
