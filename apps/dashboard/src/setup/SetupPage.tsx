import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { flyToPoint, flyToPoints } from '../map/camera';
import { useMapInput } from '../map/input';
import { BoundaryLayer } from '../map/layers/BoundaryLayer';
import { DronesLayer } from '../map/layers/DronesLayer';
import { PairingLayer } from '../map/layers/PairingLayer';
import { serverIdOf, ServersLayer } from '../map/layers/ServersLayer';
import { BoundaryTool } from '../map/tools/BoundaryTool';
import { useMap } from '../map/viewer';
import type { LatLon } from '../sim/types';
import { setupStep } from '../sim/world';
import { navigate, type SetupStep } from '../store/router';
import { useZones } from '../store/zones';
import { Button } from '../ui/Button';
import panel from '../ui/panel.module.css';
import { BoundaryStep } from './BoundaryStep';
import { DronesStep } from './DronesStep';
import { PRESETS } from './presets';
import { ServersStep } from './ServersStep';
import styles from './Setup.module.css';

const STEPS: { id: SetupStep; label: string; icon: GlyphName }[] = [
    { id: 'boundary', label: 'Boundary', icon: 'edit' },
    { id: 'servers', label: 'Edge servers', icon: 'server' },
    { id: 'drones', label: 'Drones', icon: 'drone' },
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
    const zone = useZones((s) => (zoneId ? s.zones[zoneId] : undefined));
    const [draft, setDraft] = useState<Draft>(() => ({
        points: zone?.boundary ?? [],
        closed: Boolean(zone),
    }));
    const [pairing, setPairing] = useState(false);
    const lastStep = useRef(step);
    const direction =
        STEPS.findIndex((s) => s.id === step) >= STEPS.findIndex((s) => s.id === lastStep.current)
            ? 1
            : -1;
    lastStep.current = step;

    useEffect(() => {
        if (zoneId && !zone) navigate({ name: 'zones' }, true);
    }, [zoneId, zone]);

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
        if (step !== 'drones') setPairing(false);
    }, [step]);

    const moveServer = useZones((s) => s.moveServer);
    useMapInput(step === 'servers' && Boolean(zone), {
        draggable: (e) => {
            const id = serverIdOf(e);
            return Boolean(id && zone?.servers.find((s) => s.id === id)?.status === 'pending');
        },
        onDrag: (e, point) => {
            const id = serverIdOf(e);
            if (id && zone) moveServer(zone.id, id, [point.lat, point.lon]);
        },
    });

    const index = STEPS.findIndex((s) => s.id === step);
    const reachable = (s: SetupStep) => s === 'boundary' || Boolean(zone);
    const done = (s: SetupStep) => {
        if (!zone) return false;
        const pending = setupStep(zone);
        if (s === 'boundary') return true;
        if (s === 'servers') return pending !== 2;
        return pending === null;
    };

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
                            <DronesLayer drones={zone.drones} />
                            <PairingLayer servers={zone.servers} active={pairing} />
                        </>
                    ) : null}
                </>
            ) : null}

            <motion.aside
                className={`${panel.panel} ${styles.panel}`}
                initial={{ opacity: 0, x: -40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ type: 'spring', stiffness: 260, damping: 30 }}
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
                        {STEPS.map((s, i) => (
                            <button
                                key={s.id}
                                type="button"
                                className={styles.step}
                                data-state={
                                    s.id === step ? 'current' : done(s.id) ? 'done' : 'todo'
                                }
                                disabled={!reachable(s.id)}
                                onClick={() =>
                                    zone &&
                                    navigate({ name: 'setup', zoneId: zone.id, step: s.id }, true)
                                }
                            >
                                <span className={styles.stepDot}>
                                    <AnimatePresence mode="wait" initial={false}>
                                        <motion.span
                                            key={done(s.id) && s.id !== step ? 'done' : 'icon'}
                                            initial={{ scale: 0, rotate: -40 }}
                                            animate={{ scale: 1, rotate: 0 }}
                                            exit={{ scale: 0 }}
                                            transition={{
                                                type: 'spring',
                                                stiffness: 500,
                                                damping: 22,
                                            }}
                                            style={{ display: 'grid' }}
                                        >
                                            <Icon
                                                name={
                                                    done(s.id) && s.id !== step ? 'check' : s.icon
                                                }
                                                size={14}
                                            />
                                        </motion.span>
                                    </AnimatePresence>
                                </span>
                                <span className={styles.stepLabel}>{s.label}</span>
                                {i < STEPS.length - 1 ? (
                                    <span className={styles.stepLine}>
                                        <motion.span
                                            className={styles.stepLineFill}
                                            animate={{ scaleX: i < index ? 1 : 0 }}
                                            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                                        />
                                    </span>
                                ) : null}
                            </button>
                        ))}
                    </nav>
                </header>

                <div className={styles.body}>
                    <AnimatePresence mode="wait" initial={false} custom={direction}>
                        <motion.div
                            key={step}
                            custom={direction}
                            initial={{ opacity: 0, x: 28 * direction }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -28 * direction }}
                            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        >
                            {step === 'boundary' ? (
                                <BoundaryStep
                                    zone={zone ?? null}
                                    draft={draft}
                                    setDraft={setDraft}
                                />
                            ) : zone && step === 'servers' ? (
                                <ServersStep zone={zone} />
                            ) : zone ? (
                                <DronesStep zone={zone} pairing={pairing} setPairing={setPairing} />
                            ) : null}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </motion.aside>
        </div>
    );
}
