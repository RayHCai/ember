import { AnimatePresence, motion } from 'motion/react';
import { getTelemetry, MODE_LABEL } from '../live/telemetry';
import type { ZoneView } from '../model/types';
import { hectares } from '../model/zone';
import { useUi, type Hover } from '../store/ui';
import { minutes } from '../ui/format';
import { QUICK } from '../ui/motion';
import styles from './Overlay.module.css';

function describe(zone: ZoneView, hover: Hover): { title: string; detail: string } | null {
    switch (hover.kind) {
        case 'server': {
            const s = zone.servers.find((x) => x.id === hover.id);
            if (!s) return null;
            if (s.status === 'pending')
                return { title: 'Planned edge server', detail: 'Waiting to connect' };
            const live = s.edge?.live;
            return {
                title: `Edge server ${s.name}`,
                detail: live
                    ? `${live.online ? 'Online' : 'Offline'} · ${live.connectedDrones}/${live.drones} drones connected`
                    : 'Status unknown',
            };
        }
        case 'drone': {
            const d = zone.drones.find((x) => x.id === hover.id);
            const t = getTelemetry(hover.id);
            if (!d) return null;
            return {
                title: d.name,
                detail: t
                    ? `${MODE_LABEL[t.mode]} · ${Math.round(t.batteryPct)}% battery · ${Math.round(t.altM)} m`
                    : 'No position reported',
            };
        }
        case 'risk': {
            const z = zone.riskZones.find((x) => x.id === hover.id);
            return z
                ? {
                      title: z.risk === 'on_fire' ? 'Active fire' : 'At-risk vegetation',
                      detail: `${Math.round(z.confidence * 100)}% confidence · ${hectares(z.areaM2 / 10_000)} ha`,
                  }
                : null;
        }
        case 'community': {
            const area = zone.surroundings?.civilianAreas.find((a) => a.id === hover.id);
            const impact = zone.plan?.civilianImpacts.find((c) => c.civilianAreaId === hover.id);
            if (!area) return null;
            return {
                title: area.name,
                detail:
                    !impact || impact.impactMin === null
                        ? `Not reached in ${minutes(zone.plan?.horizonMin ?? 0)}`
                        : impact.impactMin <= 0
                          ? 'Burning now'
                          : `Fire in ${minutes(impact.impactMin)}`,
            };
        }
        case 'drop': {
            const a = zone.plan?.attackZones.find((x) => x.id === hover.id);
            return a
                ? {
                      title: `Attack zone #${a.rank}`,
                      detail: `${a.tactic} · protects ${a.protectedPopulation.toLocaleString()} people`,
                  }
                : null;
        }
        case 'safe': {
            const s = zone.surroundings?.safeZones.find((x) => x.id === hover.id);
            return s ? { title: s.name, detail: 'Safe zone' } : null;
        }
        case 'station': {
            const s = zone.surroundings?.stations.find((x) => x.id === hover.id);
            return s ? { title: s.name, detail: 'Responder station' } : null;
        }
    }
}

/** A small card that follows the pointer over map items; click for the inspector. */
export function HoverCard({ zone }: { zone: ZoneView }) {
    const hover = useUi((s) => s.hover);
    const info = hover ? describe(zone, hover) : null;
    return (
        <AnimatePresence>
            {hover && info ? (
                <motion.div
                    key={`${hover.kind}:${hover.id}`}
                    className={styles.hover}
                    style={{ left: hover.x + 14, top: hover.y + 14 }}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.08 } }}
                    transition={QUICK}
                >
                    <strong>{info.title}</strong>
                    <span>{info.detail}</span>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}
