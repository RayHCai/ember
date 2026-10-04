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
import { RoadsLayer } from '../map/layers/RoadsLayer';
import { ServersLayer } from '../map/layers/ServersLayer';
import { SuggestionsLayer } from '../map/layers/SuggestionsLayer';
import { useMap } from '../map/viewer';
import { ApprovalsPanel } from '../live/ApprovalsPanel';
import { LivePanel } from '../live/LivePanel';
import { LiveStrip } from '../live/LiveStatus';
import { isLiveZoneId } from '../live/map';
import { LIVE_POLL_MS, placeFire, setRoadState, useLivePolling } from '../live/poller';
import { useLive } from '../live/store';
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

const LIVE_ONLY = 'Ember runs this itself on a live zone';

export function ZonePage({ zoneId }: { zoneId: string }) {
    const viewer = useMap((s) => s.viewer);
    const zone = useZones((s) => s.zones[zoneId]);
    const previous = useRouter((s) => s.previous);
    const ui = useUi();
    const liveId = isLiveZoneId(zoneId);
    const live = zone?.live === true;
    const liveStatus = useLive((s) => s.status);
    const tool = useLive((s) => (live ? s.tool : null));
    useLivePolling(liveId ? LIVE_POLL_MS : null);
    const present = zone !== undefined;
    const hasPlans = Boolean(zone?.civilianPlan || zone?.responderPlan);
    // Entry effects run once per zone; they read the latest values through this ref.
    const latest = useRef({ zone, cameFromSetup: previous?.name === 'setup' });
    latest.current = { zone, cameFromSetup: previous?.name === 'setup' };

    // A live zone opened by URL arrives with the first poll.
    const waiting = liveId && (liveStatus === 'connecting' || liveStatus === 'online');
    const entered = useRef<string | null>(null);
    useEffect(() => {
        const z = latest.current.zone;
        if (!z) {
            if (!waiting) navigate({ name: 'zones' }, true);
            return;
        }
        if (entered.current === z.id) return;
        entered.current = z.id;
        useUi.getState().resetForZone(z.lastScanAt !== null || riskCounts(z).mapped > 0);
    }, [zoneId, present, waiting]);

    useEffect(() => () => useLive.getState().setTool(null), [zoneId]);
    useEffect(() => {
        if (!viewer || !tool) return;
        const canvas = viewer.scene.canvas;
        canvas.style.cursor = 'crosshair';
        return () => {
            canvas.style.cursor = '';
        };
    }, [viewer, tool]);

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
    }, [viewer, zoneId, present]);

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
        cursor: tool ? 'crosshair' : undefined,
        hoverable: (e) => picked(e.id) !== null || (tool === 'road' && e.id.startsWith('road:')),
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
        onClick: (point, entity) => {
            const armed = live ? useLive.getState().tool : null;
            if (armed === 'fire') {
                if (point) void placeFire([point.lat, point.lon]);
                useLive.getState().setTool(null);
                return;
            }
            if (armed === 'road') {
                const road = entity?.id.startsWith('road:')
                    ? zone?.roads?.find((r) => r.id === entity.id.slice('road:'.length))
                    : undefined;
                if (!road) return;
                void setRoadState(road.id, road.name, road.state === 'open' ? 'blocked' : 'open');
                useLive.getState().setTool(null);
                return;
            }
            const p = entity ? picked(entity.id) : null;
            useUi.getState().select(p);
        },
    });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (useLive.getState().tool) useLive.getState().setTool(null);
            else if (!useUi.getState().blast && !useUi.getState().responderOpen)
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
            {live ? <RoadsLayer roads={zone.roads ?? []} picking={tool === 'road'} /> : null}
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
                    <span title={live ? LIVE_ONLY : undefined}>
                        <Button icon="qr" disabled={live} onClick={() => ui.setResponderOpen(true)}>
                            Connect responder
                        </Button>
                    </span>
                    <span title={live ? LIVE_ONLY : undefined}>
                        <Button
                            icon="megaphone"
                            variant="primary"
                            disabled={live}
                            onClick={() => ui.openBlast()}
                        >
                            Event blast
                        </Button>
                    </span>
                    <IconButton
                        icon="sparkle"
                        label={
                            live ? `Operator Agent: ${LIVE_ONLY.toLowerCase()}` : 'Operator Agent'
                        }
                        active={ui.agentOpen && !live}
                        disabled={live}
                        onClick={() => ui.setAgentOpen(!ui.agentOpen)}
                    />
                    <NotificationsMenu />
                </div>
            </motion.header>

            {live ? <LivePanel zone={zone} /> : <OperatorPanel zone={zone} />}
            {live ? <LiveStrip /> : null}

            <div className={styles.right}>
                {live ? <ApprovalsPanel /> : null}
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
                    {ui.agentOpen && !live ? <AgentPanel key="agent" zone={zone} /> : null}
                </AnimatePresence>
            </div>

            <div className={styles.bottom}>
                <AnimatePresence>
                    {zone.scan ? <ScanHud key="scan" zone={zone} /> : null}
                </AnimatePresence>
                <Legend
                    mode={ui.mode}
                    suggestions={ui.suggestions}
                    live={live}
                    horizonMin={zone.civilianPlan?.spread.horizonMin}
                />
            </div>

            <HoverCard zone={zone} />
            {live ? null : <BlastDialog zone={zone} />}
            {live ? null : <ResponderDialog zone={zone} />}
        </div>
    );
}
