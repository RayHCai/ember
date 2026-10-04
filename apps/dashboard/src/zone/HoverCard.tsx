import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { getTelemetry } from '../sim/live';
import type { WatchZone } from '../sim/types';
import { useUi, type Hover } from '../store/ui';
import { minutes } from '../ui/format';
import styles from './Overlay.module.css';

function describe(
    zone: WatchZone,
    hover: Hover,
): { icon: GlyphName; title: string; detail: string } | null {
    switch (hover.kind) {
        case 'server': {
            const s = zone.servers.find((x) => x.id === hover.id);
            if (!s) return null;
            const drones = zone.drones.filter((d) => d.serverId === s.id).length;
            return {
                icon: 'server',
                title: `Edge server ${s.name}`,
                detail:
                    s.status === 'pending'
                        ? 'Suggested · not deployed'
                        : `${drones} drones · ${s.health.latencyMs} ms · ${s.health.temperatureC} °C`,
            };
        }
        case 'drone': {
            const d = zone.drones.find((x) => x.id === hover.id);
            const t = getTelemetry(hover.id);
            if (!d || !t) return null;
            return {
                icon: 'drone',
                title: d.name,
                detail: `${t.state} · ${t.batteryPct}% battery · ${Math.round(t.altM)} m`,
            };
        }
        case 'report': {
            const r = zone.reports.find((x) => x.id === hover.id);
            return r ? { icon: 'camera', title: 'Civilian report', detail: r.text } : null;
        }
        case 'community': {
            const c = zone.civilianPlan?.impacts.find((x) => x.communityId === hover.id);
            return c
                ? {
                      icon: 'home',
                      title: c.name,
                      detail:
                          c.arrivalMin === null
                              ? 'Not reached in 6h'
                              : `Fire in ${minutes(c.arrivalMin)}`,
                  }
                : null;
        }
        case 'drop': {
            const s = zone.responderPlan?.dropSites.find((x) => x.id === hover.id);
            return s
                ? { icon: 'target', title: s.name, detail: `${s.purpose} · ${s.crews} crews` }
                : null;
        }
        case 'safe': {
            const s = zone.safeZones.find((x) => x.id === hover.id);
            return s ? { icon: 'shield', title: s.name, detail: 'Safe zone' } : null;
        }
    }
}

/** A small card that follows the pointer over map items; click for the inspector. */
export function HoverCard({ zone }: { zone: WatchZone }) {
    const hover = useUi((s) => s.hover);
    const info = hover ? describe(zone, hover) : null;
    return (
        <AnimatePresence>
            {hover && info ? (
                <motion.div
                    key={`${hover.kind}:${hover.id}`}
                    className={styles.hover}
                    style={{ left: hover.x + 16, top: hover.y + 16 }}
                    initial={{ opacity: 0, scale: 0.92, y: 4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
                    transition={{ type: 'spring', stiffness: 520, damping: 34 }}
                >
                    <span className={styles.hoverIcon}>
                        <Icon name={info.icon} size={14} />
                    </span>
                    <span>
                        <strong>{info.title}</strong>
                        <span>{info.detail}</span>
                    </span>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}
