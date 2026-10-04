import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { Icon } from '../icons/Icon';
import { pairNextDrone } from '../sim/actions';
import { getTelemetry } from '../sim/live';
import type { WatchZone } from '../sim/types';
import { notify } from '../store/notifications';
import { navigate } from '../store/router';
import { useZones } from '../store/zones';
import { Button } from '../ui/Button';
import panel from '../ui/panel.module.css';
import styles from './Setup.module.css';

const PER_SERVER = 2;

interface Props {
    zone: WatchZone;
    pairing: boolean;
    setPairing: (on: boolean) => void;
}

export function DronesStep({ zone, pairing, setPairing }: Props) {
    const servers = zone.servers.filter((s) => s.status === 'deployed');
    const target = servers.length * PER_SERVER;
    const paired = useRef(0);
    const latest = useRef({ zone, setPairing });
    latest.current = { zone, setPairing };
    const zoneId = zone.id;

    useEffect(() => {
        if (!pairing) return;
        paired.current = 0;
        const timer = window.setInterval(() => {
            const current = useZones.getState().zones[zoneId];
            if (!current || current.drones.length >= target) {
                latest.current.setPairing(false);
                return;
            }
            if (pairNextDrone(zoneId)) paired.current += 1;
        }, 1100);
        return () => {
            window.clearInterval(timer);
            const z = latest.current.zone;
            if (paired.current)
                notify(
                    'success',
                    'Drones paired',
                    `${paired.current} drones joined the ${z.name} fleet.`,
                    z,
                );
            paired.current = 0;
        };
    }, [pairing, zoneId, target]);

    if (servers.length === 0) {
        return (
            <div className={styles.stepBody}>
                <div className={panel.callout}>
                    <Icon name="server" size={18} />
                    <span>
                        <strong>Deploy edge servers first</strong>
                        Drones pair with an edge server over its local network.
                    </span>
                </div>
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
            <p className={panel.lead}>
                Set a drone down within range of an edge server and power it on. It finds the
                server's network, sends its hardware details, and joins the fleet.
            </p>

            <div className={styles.pairCard} data-active={pairing}>
                <span className={styles.radar}>
                    <span />
                    <span />
                    <Icon name="drone" size={22} />
                </span>
                <span>
                    <strong>
                        {pairing
                            ? 'Listening for drones'
                            : zone.drones.length
                              ? 'Pairing paused'
                              : 'Ready to pair'}
                    </strong>
                    <span className={panel.muted}>
                        {zone.drones.length} of {target} suggested · {servers.length} edge servers
                        listening
                    </span>
                </span>
            </div>

            <ul className={panel.list}>
                <AnimatePresence initial={false}>
                    {zone.drones.map((d) => {
                        const server = zone.servers.find((s) => s.id === d.serverId);
                        return (
                            <motion.li
                                key={d.id}
                                className={panel.item}
                                layout
                                initial={{ opacity: 0, scale: 0.9, y: -8 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                transition={{ type: 'spring', stiffness: 420, damping: 28 }}
                            >
                                <span className={panel.itemIcon} data-tone="flame">
                                    <Icon name="drone" size={16} />
                                </span>
                                <span className={panel.itemText}>
                                    <strong>{d.name}</strong>
                                    <span className="mono">{d.id}</span>
                                </span>
                                <span className={panel.tag} data-tone="ok">
                                    {server?.name} · {getTelemetry(d.id)?.batteryPct ?? 100}%
                                </span>
                            </motion.li>
                        );
                    })}
                </AnimatePresence>
            </ul>

            <div className={styles.footer}>
                {pairing ? (
                    <Button block size="lg" icon="stop" onClick={() => setPairing(false)}>
                        Stop pairing
                    </Button>
                ) : (
                    <Button
                        block
                        size="lg"
                        variant={zone.drones.length >= target ? 'secondary' : 'primary'}
                        icon="radar"
                        onClick={() => setPairing(true)}
                        disabled={zone.drones.length >= target}
                    >
                        {zone.drones.length ? 'Pair more drones' : 'Start pairing'}
                    </Button>
                )}
                <Button
                    variant={zone.drones.length >= target ? 'primary' : 'ghost'}
                    size={zone.drones.length >= target ? 'lg' : 'sm'}
                    block
                    iconAfter="arrowRight"
                    disabled={pairing}
                    onClick={() => navigate({ name: 'zone', zoneId: zone.id })}
                >
                    {zone.drones.length ? 'Finish and open zone' : 'Skip for now'}
                </Button>
            </div>
        </div>
    );
}
