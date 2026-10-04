import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import { flyToPoint, flyToPoints } from '../map/camera';
import { useMapInput } from '../map/input';
import { BoundaryLayer } from '../map/layers/BoundaryLayer';
import { DronesLayer } from '../map/layers/DronesLayer';
import { PairingLayer } from '../map/layers/PairingLayer';
import { serverIdOf, ServersLayer } from '../map/layers/ServersLayer';
import { BoundaryTool } from '../map/tools/BoundaryTool';
import { useWatchedDrones } from '../live/droneInfo';
import { useMap } from '../map/viewer';
import type { LatLon } from '../model/types';
import { setupStep } from '../model/zone';
import { addPlacement, dragPlacement, savePlacement } from '../store/actions';
import { navigate, type SetupStep } from '../store/router';
import { useZoneSync } from '../store/sync';
import { useZones, useZoneView } from '../store/zones';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { QUICK, SMOOTH, SNAP } from '../ui/motion';
import { BoundaryStep } from './BoundaryStep';
import { DronesStep } from './DronesStep';
import { PRESETS } from './presets';
import { ServersStep } from './ServersStep';
import styles from './Setup.module.css';

const STEPS: { id: SetupStep; label: string }[] = [
    { id: 'boundary', label: 'Boundary' },
    { id: 'servers', label: 'Edge servers' },
    { id: 'drones', label: 'Drones' },
];

export const PANEL_FRAME = { left: 0.36, right: 0.06, top: 0.12, bottom: 0.1 };

export interface Draft {
    points: LatLon[];
    closed: boolean;
}

interface Props {
    zoneId: string | null;
    step: SetupStep;
}

/** Onboarding for a watch zone: draw the boundary, place edge servers, pair drones. */
export function SetupPage({ zoneId, step }: Props) {
    const viewer = useMap((s) => s.viewer);
    useZoneSync(zoneId, { unassigned: step === 'servers' });
    const zone = useZoneView(zoneId);
    useWatchedDrones(zone?.drones.map((d) => d.id) ?? []);
    const missing = useZones((s) => (zoneId ? s.missing[zoneId] === true : false));
    const [draft, setDraft] = useState<Draft>(() => ({
        points: zone?.boundary ?? [],
        closed: Boolean(zone),
    }));
    const [radiusM, setRadiusM] = useState(500);
    const [pinpointing, setPinpointing] = useState(false);
    const lastStep = useRef(step);
    const direction =
        STEPS.findIndex((s) => s.id === step) >= STEPS.findIndex((s) => s.id === lastStep.current)
            ? 1
            : -1;
    lastStep.current = step;

    useEffect(() => {
        if (missing) navigate({ name: 'zones' }, true);
    }, [missing]);

    // A zone opened by link loads after the page mounts; start editing from its boundary.
    const seeded = useRef(Boolean(zone));
    useEffect(() => {
        if (seeded.current || !zone) return;
        seeded.current = true;
        setDraft({ points: zone.boundary, closed: true });
    }, [zone]);

    // Frame the zone when it changes; a brand new zone starts over a fire-prone forest.
    const framed = useRef<string | null>(null);
    const boundary = useRef(zone?.boundary);
    boundary.current = zone?.boundary;
    const key = zone?.id ?? 'new';
    useEffect(() => {
        if (!viewer || framed.current === key) return;
        const fromNew = framed.current === 'new';
        framed.current = key;
        if (boundary.current)
            void flyToPoints(viewer, boundary.current, {
                frame: PANEL_FRAME,
                duration: fromNew ? 1.2 : 1.8,
            });
        else void flyToPoint(viewer, PRESETS[0]!.at, PRESETS[0]!.heightM, 2.2);
    }, [viewer, key]);

    useEffect(() => {
        if (step !== 'servers') setPinpointing(false);
    }, [step]);

    useMapInput(step === 'servers' && Boolean(zone), {
        cursor: pinpointing ? 'crosshair' : undefined,
        draggable: (e) => {
            const id = serverIdOf(e);
            return Boolean(id && zone?.servers.find((s) => s.id === id)?.status === 'pending');
        },
        onDrag: (e, point) => {
            const id = serverIdOf(e);
            if (id && zone) dragPlacement(zone.id, id, [point.lat, point.lon]);
        },
        onDragEnd: (e) => {
            const id = serverIdOf(e);
            if (id && zone) void savePlacement(zone.id, id);
        },
        onClick: (point, entity) => {
            if (!pinpointing || !zone || !point || (entity && serverIdOf(entity))) return;
            void addPlacement(zone.id, [point.lat, point.lon], radiusM);
        },
    });

    const reachable = (s: SetupStep) => s === 'boundary' || Boolean(zone);
    const done = (s: SetupStep) => {
        if (!zone) return false;
        const pending = setupStep(zone);
        if (s === 'boundary') return true;
        if (s === 'servers') return pending !== 2;
        return pending === null;
    };
    const loading = Boolean(zoneId && !zone);

    return (
        <div className={styles.page}>
            {step === 'boundary' ? (
                <BoundaryTool
                    points={draft.points}
                    closed={draft.closed}
                    active
                    onChange={(points, closed) => setDraft({ points, closed })}
                />
            ) : zone ? (
                <>
                    <BoundaryLayer boundary={zone.boundary} outside={0.42} fill={0.04} />
                    <ServersLayer servers={zone.servers} />
                    {step === 'drones' ? (
                        <>
                            <DronesLayer drones={zone.drones} servers={zone.servers} />
                            <PairingLayer servers={zone.servers} active />
                        </>
                    ) : null}
                </>
            ) : null}

            <motion.aside
                className={styles.panel}
                initial={{ opacity: 0, x: -24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24, transition: QUICK }}
                transition={SMOOTH}
            >
                <header className={styles.head}>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon="arrowLeft"
                        onClick={() =>
                            navigate(
                                zone && setupStep(zone) === null
                                    ? { name: 'zone', zoneId: zone.id }
                                    : { name: 'zones' },
                            )
                        }
                    >
                        {zone && setupStep(zone) === null ? zone.name : 'Watch zones'}
                    </Button>
                    <h1 className={styles.title}>
                        {zone
                            ? step === 'boundary'
                                ? 'Edit boundary'
                                : zone.name
                            : 'New watch zone'}
                    </h1>
                    <nav className={styles.stepper} aria-label="Setup steps">
                        {STEPS.map((s, i) => {
                            const checked = done(s.id) && s.id !== step;
                            return (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={styles.step}
                                    data-state={
                                        s.id === step ? 'current' : checked ? 'done' : 'todo'
                                    }
                                    disabled={!reachable(s.id)}
                                    onClick={() =>
                                        zone &&
                                        navigate(
                                            { name: 'setup', zoneId: zone.id, step: s.id },
                                            true,
                                        )
                                    }
                                >
                                    <span className={styles.stepDot}>
                                        {checked ? <Icon name="check" size={10} /> : i + 1}
                                    </span>
                                    {s.label}
                                    {s.id === step ? (
                                        <motion.span
                                            layoutId="setup-step"
                                            className={styles.stepLine}
                                            transition={SNAP}
                                        />
                                    ) : null}
                                </button>
                            );
                        })}
                    </nav>
                </header>

                <div className={styles.body}>
                    <AnimatePresence mode="wait" initial={false} custom={direction}>
                        <motion.div
                            key={step}
                            custom={direction}
                            initial={{ opacity: 0, x: 20 * direction }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 * direction, transition: QUICK }}
                            transition={SMOOTH}
                        >
                            {loading ? (
                                <div className={styles.processing}>
                                    <Spinner size={16} />
                                    <span>
                                        <strong>Loading the zone</strong>
                                    </span>
                                </div>
                            ) : step === 'boundary' ? (
                                <BoundaryStep
                                    zone={zone ?? null}
                                    draft={draft}
                                    setDraft={setDraft}
                                />
                            ) : zone && step === 'servers' ? (
                                <ServersStep
                                    zone={zone}
                                    radiusM={radiusM}
                                    setRadiusM={setRadiusM}
                                    pinpointing={pinpointing}
                                    setPinpointing={setPinpointing}
                                />
                            ) : zone ? (
                                <DronesStep zone={zone} />
                            ) : null}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </motion.aside>
        </div>
    );
}
