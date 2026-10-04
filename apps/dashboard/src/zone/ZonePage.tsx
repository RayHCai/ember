import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { tweenSaturation } from '../map/base';
import { flyToPoints } from '../map/camera';
import { useMapInput } from '../map/input';
import { BoundaryLayer } from '../map/layers/BoundaryLayer';
import { DetectionLayer } from '../map/layers/DetectionLayer';
import { DronesLayer } from '../map/layers/DronesLayer';
import { RiskLayer } from '../map/layers/RiskLayer';
import { serverIdOf, ServersLayer } from '../map/layers/ServersLayer';
import { SuggestionsLayer } from '../map/layers/SuggestionsLayer';
import { useWatchedDrones } from '../live/droneInfo';
import { useMap } from '../map/viewer';
import { ZoomControl } from '../map/ZoomControl';
import type { LatLon, ZoneView } from '../model/types';
import { deployed, isActiveScan, ll } from '../model/zone';
import {
    assignPlacement,
    dragPlacement,
    runPlanner,
    savePlacement,
    startScan,
} from '../store/actions';
import { navigate, useRouter } from '../store/router';
import { useZoneSync } from '../store/sync';
import { useUi, type Pickable } from '../store/ui';
import { useZones, useZoneView } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { QUICK, SMOOTH } from '../ui/motion';
import { Segmented } from '../ui/Segmented';
import { Spinner } from '../ui/Spinner';
import { Toggle } from '../ui/Toggle';
import { BlastDialog } from './BlastDialog';
import { HoverCard } from './HoverCard';
import { Inspector } from './Inspector';
import { Legend } from './Legend';
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

const ZONE_FRAME = { left: 0.14, right: 0.24, top: 0.16, bottom: 0.18 };

/** An edge server the api reports online, and that no zone has yet, takes the next planned site. */
function useAutoAssign(zone: ZoneView | undefined): void {
    const unassigned = useZones((s) => s.unassigned);
    const busy = useRef(false);
    const refused = useRef(new Set<string>());
    const site = zone?.servers.find((s) => s.status === 'pending');
    const edge = unassigned.find((e) => e.live?.online && !refused.current.has(e.edgeServerId));
    const zoneId = zone?.id;
    const siteId = site?.id;
    const edgeServerId = edge?.edgeServerId;

    useEffect(() => {
        if (!zoneId || !siteId || !edgeServerId || busy.current) return;
        busy.current = true;
        void assignPlacement(zoneId, siteId, edgeServerId).then((ok) => {
            if (!ok) refused.current.add(edgeServerId);
            busy.current = false;
        });
    }, [zoneId, siteId, edgeServerId]);
}

export function ZonePage({ zoneId }: { zoneId: string }) {
    const viewer = useMap((s) => s.viewer);
    useZoneSync(zoneId, { unassigned: true });
    const zone = useZoneView(zoneId);
    useAutoAssign(zone);
    const missing = useZones((s) => s.missing[zoneId] === true);
    useWatchedDrones(zone?.drones.map((d) => d.id) ?? []);
    const previous = useRouter((s) => s.previous);
    const ui = useUi();
    const [starting, setStarting] = useState(false);
    // Suggestions were asked for before any plan existed: they turn on when the planner finishes.
    const [awaitingPlan, setAwaitingPlan] = useState(false);
    const loaded = zone !== undefined;
    // Entry effects run once per zone; they read the latest values through this ref.
    const latest = useRef({ zone, cameFromDraw: previous?.name === 'new' });
    latest.current = { zone, cameFromDraw: previous?.name === 'new' };

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
        const { zone: z, cameFromDraw } = latest.current;
        if (!viewer || !z || flown.current === z.id) return;
        flown.current = z.id;
        void flyToPoints(viewer, z.boundary, {
            frame: ZONE_FRAME,
            dive: !cameFromDraw,
            duration: cameFromDraw ? 1.2 : 2.1,
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

    const hasPlan = Boolean(zone?.plan);
    const planFailed = zone?.planJob?.state === 'failed';
    useEffect(() => {
        if (!awaitingPlan) return;
        if (hasPlan) useUi.getState().setSuggestions(true);
        if (hasPlan || planFailed) setAwaitingPlan(false);
    }, [awaitingPlan, hasPlan, planFailed]);

    // A plan that lands while the zone is open (the operator-agent asks for one after a scan finds
    // fire) shows itself; the plan the zone opened with does not.
    const planJobId = zone?.plan?.jobId ?? null;
    const seenPlan = useRef<{ zoneId: string; jobId: string | null } | null>(null);
    useEffect(() => {
        if (!loaded) return;
        const seen = seenPlan.current;
        seenPlan.current = { zoneId, jobId: planJobId };
        if (seen?.zoneId === zoneId && planJobId && planJobId !== seen.jobId)
            useUi.getState().setSuggestions(true);
    }, [zoneId, loaded, planJobId]);

    const moved = useRef(false);
    const pendingSite = (id: string | null) =>
        Boolean(id && zone?.servers.find((s) => s.id === id)?.status === 'pending');

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
        // A planned site can be moved until an edge server takes it.
        draggable: (e) => pendingSite(serverIdOf(e)),
        onDrag: (e, point) => {
            const id = serverIdOf(e);
            if (!id) return;
            moved.current = true;
            dragPlacement(zoneId, id, [point.lat, point.lon]);
        },
        onDragEnd: (e) => {
            const id = serverIdOf(e);
            if (id && moved.current) void savePlacement(zoneId, id);
            moved.current = false;
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
    const detection = ui.mode === 'detection';
    const ready = deployed(zone).length > 0;
    const review = zone.blasts.find((b) => b.state === 'pending_approval');

    const scan = async () => {
        setStarting(true);
        const started = await startScan(zone.id);
        setStarting(false);
        if (started && started.state !== 'failed') ui.setMode('detection');
    };

    const setSuggestions = async (on: boolean) => {
        if (!on) {
            setAwaitingPlan(false);
            ui.setSuggestions(false);
            return;
        }
        const stale = zone.plan && (zone.lastScanAt ?? 0) > (zone.planAt ?? 0);
        if (zone.plan) ui.setSuggestions(true);
        else setAwaitingPlan(true);
        if ((!zone.plan || stale) && !zone.planning && !(await runPlanner(zone.id)))
            setAwaitingPlan(false);
    };

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
                    <IconButton
                        icon="edit"
                        label="Redraw boundary"
                        onClick={() => navigate({ name: 'edit', zoneId: zone.id })}
                    />
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
                    <label className={styles.suggestToggle} data-disabled={!ready}>
                        Suggestions
                        {awaitingPlan || (ui.suggestions && zone.planning) ? (
                            <Spinner size={12} />
                        ) : null}
                        <Toggle
                            on={ui.suggestions || awaitingPlan}
                            onChange={(on) => void setSuggestions(on)}
                            label="Suggestions overlay"
                            disabled={!ready}
                        />
                    </label>
                </div>

                <div className={styles.barActions}>
                    {zone.scan ? null : (
                        <Button
                            icon="play"
                            loading={starting}
                            disabled={!ready}
                            onClick={() => void scan()}
                        >
                            Scan
                        </Button>
                    )}
                    {review ? (
                        <Button
                            variant="danger"
                            onClick={() =>
                                ui.openBlast(
                                    {
                                        audience: review.audience,
                                        priority: review.priority,
                                        title: review.title,
                                        body: review.body,
                                        area: review.area,
                                    },
                                    true,
                                    review.blastId,
                                )
                            }
                        >
                            Review blast
                        </Button>
                    ) : null}
                </div>
            </motion.header>

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
                <ZoomControl className={styles.zoom} />
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
