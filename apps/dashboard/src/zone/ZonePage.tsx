import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { NotificationsMenu } from '../chrome/NotificationsMenu';
import { Icon } from '../icons/Icon';
import { tweenSaturation } from '../map/base';
import { flyToPoints } from '../map/camera';
import { useMapInput } from '../map/input';
import { BoundaryLayer } from '../map/layers/BoundaryLayer';
import { DetectionLayer } from '../map/layers/DetectionLayer';
import { DronesLayer } from '../map/layers/DronesLayer';
import { GapsLayer } from '../map/layers/GapsLayer';
import { ReportsLayer } from '../map/layers/ReportsLayer';
import { ServersLayer } from '../map/layers/ServersLayer';
import { SuggestionsLayer } from '../map/layers/SuggestionsLayer';
import { useMap } from '../map/viewer';
import { riskCounts, setupStep, zoneStatus } from '../sim/world';
import type { LatLon } from '../sim/types';
import { navigate, useRouter } from '../store/router';
import { useUi, type Pickable } from '../store/ui';
import { useZones } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { StatusPill } from '../ui/StatusPill';
import { Toggle } from '../ui/Toggle';
import { AgentPanel } from './AgentPanel';
import { BlastDialog } from './BlastDialog';
import { HoverCard } from './HoverCard';
import { Inspector } from './Inspector';
import { Legend } from './Legend';
import { OperatorPanel } from './OperatorPanel';
import { ResponderDialog } from './ResponderDialog';
import { ScanHud } from './ScanHud';
import styles from './Zone.module.css';

const PICKABLE = new Set<string>(['server', 'drone', 'report', 'community', 'drop', 'safe']);

function picked(id: string): { kind: Pickable; id: string } | null {
    const kind = id.slice(0, id.indexOf(':'));
    return PICKABLE.has(kind) ? { kind: kind as Pickable, id: id.slice(kind.length + 1) } : null;
}

export const ZONE_FRAME = { left: 0.3, right: 0.2, top: 0.16, bottom: 0.18 };

export function ZonePage({ zoneId }: { zoneId: string }) {
    const viewer = useMap((s) => s.viewer);
    const zone = useZones((s) => s.zones[zoneId]);
    const previous = useRouter((s) => s.previous);
    const ui = useUi();
    const hasPlans = Boolean(zone?.civilianPlan || zone?.responderPlan);
    // Entry effects run once per zone; they read the latest values through this ref.
    const latest = useRef({ zone, cameFromSetup: previous?.name === 'setup' });
    latest.current = { zone, cameFromSetup: previous?.name === 'setup' };

    useEffect(() => {
        const z = latest.current.zone;
        if (!z) {
            navigate({ name: 'zones' }, true);
            return;
        }
        useUi.getState().resetForZone(z.lastScanAt !== null || riskCounts(z).mapped > 0);
    }, [zoneId]);

    const flown = useRef<string | null>(null);
    useEffect(() => {
        const { zone: z, cameFromSetup } = latest.current;
        if (!viewer || !z || flown.current === z.id) return;
        flown.current = z.id;
        void flyToPoints(viewer, z.boundary, {
            frame: ZONE_FRAME,
            dive: !cameFromSetup,
            duration: cameFromSetup ? 1.2 : 2.1,
        });
    }, [viewer, zoneId]);

    useEffect(() => {
        tweenSaturation(ui.mode === 'detection' ? 0 : 1);
    }, [ui.mode]);

    // Plans reach past the boundary (towns, routes, safe zones): pull back to show them,
    // and return to the zone when they are hidden again.
    const shownSuggestions = useRef(ui.suggestions);
    useEffect(() => {
        const z = latest.current.zone;
        if (shownSuggestions.current === ui.suggestions || !viewer || !z) return;
        shownSuggestions.current = ui.suggestions;
        const points: LatLon[] = [...z.boundary];
        if (ui.suggestions) {
            for (const c of z.civilianPlan?.impacts ?? [])
                if (c.urgency > 0) points.push([c.lat, c.lon]);
            for (const r of z.civilianPlan?.routes ?? []) points.push(r.path[r.path.length - 1]!);
            for (const d of z.responderPlan?.dropSites ?? []) points.push([d.lat, d.lon]);
        }
        void flyToPoints(viewer, points, { frame: ZONE_FRAME, duration: 1.4 });
    }, [viewer, ui.suggestions]);
    useEffect(() => () => tweenSaturation(1), []);

    useMapInput(Boolean(zone), {
        hoverable: (e) => picked(e.id) !== null,
        onMove: (_, entity, screen) => {
            const p = entity ? picked(entity.id) : null;
            const current = useUi.getState().hover;
            if (!p) {
                if (current) useUi.getState().setHover(null);
                return;
            }
            useUi.getState().setHover({ ...p, x: screen.x, y: screen.y });
        },
        onLeave: () => useUi.getState().setHover(null),
        onClick: (_, entity) => {
            const p = entity ? picked(entity.id) : null;
            useUi.getState().select(p);
        },
    });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !useUi.getState().blast && !useUi.getState().responderOpen)
                useUi.getState().select(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    if (!zone) return null;
    const status = zoneStatus(zone);
    const detection = ui.mode === 'detection';

    return (
        <div className={styles.page}>
            <BoundaryLayer
                boundary={zone.boundary}
                outside={detection ? 0.25 : 0.55}
                fill={detection ? 0 : 0.035}
            />
            <DetectionLayer zone={zone} visible={detection} />
            <SuggestionsLayer
                civilian={zone.civilianPlan}
                responder={zone.responderPlan}
                safeZones={zone.safeZones}
                visible={ui.suggestions}
            />
            <GapsLayer zone={zone} until={ui.gapsUntil} />
            <ServersLayer
                servers={zone.servers}
                radii={!detection}
                selectedId={ui.selected?.kind === 'server' ? ui.selected.id : null}
            />
            <ReportsLayer reports={zone.reports} />
            <DronesLayer
                drones={zone.drones}
                selectedId={ui.selected?.kind === 'drone' ? ui.selected.id : null}
            />

            <motion.header
                className={styles.header}
                initial={{ opacity: 0, y: -16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
                <div className={styles.titleCard}>
                    <IconButton
                        icon="arrowLeft"
                        label="All watch zones"
                        tip={false}
                        onClick={() => navigate({ name: 'zones' })}
                    />
                    <div className={styles.titleText}>
                        <motion.h1 layoutId={`zone-title-${zone.id}`} className={styles.title}>
                            {zone.name}
                        </motion.h1>
                        <span className={styles.region}>{zone.region}</span>
                    </div>
                    <StatusPill status={status} step={setupStep(zone)} />
                </div>

                <div className={styles.modeCard}>
                    <Segmented
                        label="Map overlay"
                        value={ui.mode}
                        onChange={ui.setMode}
                        options={[
                            { value: 'operator', label: 'Operator', icon: 'server' },
                            { value: 'detection', label: 'Detection', icon: 'radar' },
                        ]}
                    />
                    <label
                        className={styles.suggestToggle}
                        data-disabled={!hasPlans}
                        title={hasPlans ? undefined : 'Run a planner first'}
                    >
                        <Icon name="route" size={15} />
                        Suggestions
                        <Toggle
                            on={ui.suggestions}
                            onChange={ui.setSuggestions}
                            label="Suggestions overlay"
                            disabled={!hasPlans}
                        />
                    </label>
                </div>

                <div className={styles.actions}>
                    <Button icon="qr" onClick={() => ui.setResponderOpen(true)}>
                        Connect responder
                    </Button>
                    <Button icon="megaphone" variant="primary" onClick={() => ui.openBlast()}>
                        Event blast
                    </Button>
                    <IconButton
                        icon="sparkle"
                        label="Operator Agent"
                        active={ui.agentOpen}
                        onClick={() => ui.setAgentOpen(!ui.agentOpen)}
                    />
                    <NotificationsMenu />
                </div>
            </motion.header>

            <OperatorPanel zone={zone} />

            <div className={styles.right}>
                <AnimatePresence mode="wait">
                    {ui.selected ? (
                        <Inspector
                            key={`${ui.selected.kind}:${ui.selected.id}`}
                            zone={zone}
                            picked={ui.selected}
                        />
                    ) : null}
                </AnimatePresence>
                <AnimatePresence>
                    {ui.agentOpen ? <AgentPanel key="agent" zone={zone} /> : null}
                </AnimatePresence>
            </div>

            <div className={styles.bottom}>
                <AnimatePresence>
                    {zone.scan ? <ScanHud key="scan" zone={zone} /> : null}
                </AnimatePresence>
                <Legend mode={ui.mode} suggestions={ui.suggestions} />
            </div>

            <HoverCard zone={zone} />
            <BlastDialog zone={zone} />
            <ResponderDialog zone={zone} />
        </div>
    );
}
