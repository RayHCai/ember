import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { NotificationsMenu } from '../chrome/NotificationsMenu';
import { tweenSaturation } from '../map/base';
import { flyToPoints } from '../map/camera';
import { useMapInput } from '../map/input';
import { BoundaryLayer } from '../map/layers/BoundaryLayer';
import { DetectionLayer } from '../map/layers/DetectionLayer';
import { DronesLayer } from '../map/layers/DronesLayer';
import { GapsLayer } from '../map/layers/GapsLayer';
import { RiskLayer } from '../map/layers/RiskLayer';
import { ServersLayer } from '../map/layers/ServersLayer';
import { SuggestionsLayer } from '../map/layers/SuggestionsLayer';
import { useWatchedDrones } from '../live/droneInfo';
import { useMap } from '../map/viewer';
import type { LatLon } from '../model/types';
import { isActiveScan, ll, setupStep, zoneStatus } from '../model/zone';
import { navigate, useRouter } from '../store/router';
import { useZoneSync } from '../store/sync';
import { useUi, type Pickable } from '../store/ui';
import { useZones, useZoneView } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { QUICK, SMOOTH } from '../ui/motion';
import { Segmented } from '../ui/Segmented';
import { Spinner } from '../ui/Spinner';
import { StatusPill } from '../ui/StatusPill';
import { Toggle } from '../ui/Toggle';
import { AgentPanel } from './AgentPanel';
import { BlastDialog } from './BlastDialog';
import { HoverCard } from './HoverCard';
import { Inspector } from './Inspector';
import { Legend } from './Legend';
import { OperatorPanel } from './OperatorPanel';
import { ScanHud } from './ScanHud';
import styles from './Zone.module.css';

const PICKABLE = new Set<string>([
    'server',
    'drone',
    'risk',
    'community',
    'drop',
    'safe',
    'station',
]);

function picked(id: string): { kind: Pickable; id: string } | null {
    const kind = id.slice(0, id.indexOf(':'));
    return PICKABLE.has(kind) ? { kind: kind as Pickable, id: id.slice(kind.length + 1) } : null;
}

export const ZONE_FRAME = { left: 0.3, right: 0.2, top: 0.16, bottom: 0.18 };

export function ZonePage({ zoneId }: { zoneId: string }) {
    const viewer = useMap((s) => s.viewer);
    useZoneSync(zoneId, { unassigned: true });
    const zone = useZoneView(zoneId);
    const missing = useZones((s) => s.missing[zoneId] === true);
    useWatchedDrones(zone?.drones.map((d) => d.id) ?? []);
    const previous = useRouter((s) => s.previous);
    const ui = useUi();
    const hasPlans = Boolean(zone?.plan);
    const loaded = zone !== undefined;
    // Entry effects run once per zone; they read the latest values through this ref.
    const latest = useRef({ zone, cameFromSetup: previous?.name === 'setup' });
    latest.current = { zone, cameFromSetup: previous?.name === 'setup' };

    useEffect(() => {
        if (missing) navigate({ name: 'zones' }, true);
    }, [missing]);

    useEffect(() => {
        const z = latest.current.zone;
        if (!z) return;
        useUi
            .getState()
            .resetForZone(z.lastScanAt !== null || z.runs.length > 0 || isActiveScan(z.scan));
    }, [zoneId, loaded]);

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
    }, [viewer, zoneId, loaded]);

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
        if (ui.suggestions && z.plan) {
            const areas = new Map((z.surroundings?.civilianAreas ?? []).map((a) => [a.id, a]));
            for (const c of z.plan.civilianImpacts) {
                const area = areas.get(c.civilianAreaId);
                if (c.gradient > 0 && area) points.push(ll(area.center));
            }
            for (const r of z.plan.evacuationRoutes)
                if (r.path.length) points.push(ll(r.path[r.path.length - 1]!));
            for (const a of z.plan.attackZones) points.push(ll(a.dropSite));
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
            if (e.key === 'Escape' && !useUi.getState().blast) useUi.getState().select(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    if (!zone)
        return (
            <div className={styles.page}>
                <div className={styles.loading}>
                    <Spinner size={18} />
                </div>
            </div>
        );
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
                plan={zone.plan}
                surroundings={zone.surroundings}
                visible={ui.suggestions}
            />
            <RiskLayer
                zones={zone.riskZones}
                live={zone.scan !== null}
                visible={detection}
                selectedId={ui.selected?.kind === 'risk' ? ui.selected.id : null}
            />
            <GapsLayer zone={zone} until={ui.gapsUntil} />
            <ServersLayer
                servers={zone.servers}
                radii={!detection}
                selectedId={ui.selected?.kind === 'server' ? ui.selected.id : null}
            />
            <DronesLayer
                drones={zone.drones}
                servers={zone.servers}
                selectedId={ui.selected?.kind === 'drone' ? ui.selected.id : null}
            />

            <motion.header
                className={styles.bar}
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12, transition: QUICK }}
                transition={SMOOTH}
            >
                <div className={styles.barTitle}>
                    <IconButton
                        icon="arrowLeft"
                        label="All watch zones"
                        tip={false}
                        onClick={() => navigate({ name: 'zones' })}
                    />
                    <motion.h1 layoutId={`zone-title-${zone.id}`} className={styles.title}>
                        {zone.name}
                    </motion.h1>
                    <span className={styles.region}>{zone.region}</span>
                    <StatusPill status={status} step={setupStep(zone)} />
                </div>

                <div className={styles.barMode}>
                    <Segmented
                        label="Map overlay"
                        value={ui.mode}
                        onChange={ui.setMode}
                        options={[
                            { value: 'operator', label: 'Operator' },
                            { value: 'detection', label: 'Detection' },
                        ]}
                    />
                    <label
                        className={styles.suggestToggle}
                        data-disabled={!hasPlans}
                        title={hasPlans ? undefined : 'Run a planner first'}
                    >
                        Suggestions
                        <Toggle
                            on={ui.suggestions}
                            onChange={ui.setSuggestions}
                            label="Suggestions overlay"
                            disabled={!hasPlans}
                        />
                    </label>
                </div>

                <div className={styles.barActions}>
                    <Button icon="megaphone" variant="primary" onClick={() => ui.openBlast()}>
                        Event blast
                    </Button>
                    <IconButton
                        icon="sparkle"
                        label="Operator Agent"
                        active={ui.agentOpen}
                        tip={!ui.agentOpen}
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
        </div>
    );
}
