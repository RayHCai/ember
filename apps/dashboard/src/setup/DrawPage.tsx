import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../icons/Icon';
import { flyToPoint, flyToPoints } from '../map/camera';
import { geocode } from '../map/geocode';
import { BoundaryTool } from '../map/tools/BoundaryTool';
import { useMap } from '../map/viewer';
import { ZoomControl } from '../map/ZoomControl';
import type { LatLon } from '../model/types';
import { latLng } from '../model/zone';
import { createZone, DEFAULT_RADIUS_M, suggestPlacements, updateZone } from '../store/actions';
import { navigate } from '../store/router';
import { useZoneSync } from '../store/sync';
import { useZones, useZoneView } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { QUICK, SMOOTH } from '../ui/motion';
import { Spinner } from '../ui/Spinner';
import styles from './Draw.module.css';

// A new zone starts over fire-prone forest: the San Gabriel foothills.
const START: LatLon = [34.2, -118.09];
const START_HEIGHT_M = 22_000;

interface Draft {
    points: LatLon[];
    closed: boolean;
}

/**
 * Draws a watch zone on the bare map. Next stores it and plans its edge server sites; with a
 * `zoneId` it redraws that zone's boundary instead.
 */
export function DrawPage({ zoneId }: { zoneId: string | null }) {
    const viewer = useMap((s) => s.viewer);
    const source = useMap((s) => s.source);
    useZoneSync(zoneId);
    const zone = useZoneView(zoneId);
    const missing = useZones((s) => (zoneId ? s.missing[zoneId] === true : false));
    const [draft, setDraft] = useState<Draft>(() => ({
        points: zone?.boundary ?? [],
        closed: Boolean(zone),
    }));
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (missing) navigate({ name: 'zones' }, true);
    }, [missing]);

    // A zone opened by link loads after the page mounts; start from its boundary then.
    const seeded = useRef(Boolean(zone));
    useEffect(() => {
        if (seeded.current || !zone) return;
        seeded.current = true;
        setDraft({ points: zone.boundary, closed: true });
    }, [zone]);

    const framed = useRef(false);
    const boundary = zone?.boundary;
    useEffect(() => {
        if (!viewer || framed.current || (zoneId && !boundary)) return;
        framed.current = true;
        if (boundary) void flyToPoints(viewer, boundary, { duration: 1.4 });
        else void flyToPoint(viewer, START, START_HEIGHT_M, 2.2);
    }, [viewer, zoneId, boundary]);

    const search = async (e: FormEvent) => {
        e.preventDefault();
        if (!viewer || !query.trim() || searching) return;
        setSearching(true);
        try {
            const [place] = await geocode(query.trim(), source?.id, viewer.scene);
            setNotFound(!place);
            if (place)
                void flyToPoint(
                    viewer,
                    [place.lat, place.lon],
                    Math.min(60_000, Math.max(8_000, place.extentM * 2.4)),
                );
        } catch {
            setNotFound(true);
        } finally {
            setSearching(false);
        }
    };

    const next = async () => {
        if (!draft.closed || saving) return;
        setSaving(true);
        try {
            if (!zone) {
                const created = await createZone(draft.points);
                if (!created) return;
                await suggestPlacements(created.id, DEFAULT_RADIUS_M);
                navigate({ name: 'zone', zoneId: created.id }, true);
                return;
            }
            if (draft.points !== zone.boundary) {
                if (!(await updateZone(zone.id, { boundary: draft.points.map(latLng) }))) return;
                await suggestPlacements(zone.id, zone.servers[0]?.radiusM ?? DEFAULT_RADIUS_M);
            }
            navigate({ name: 'zone', zoneId: zone.id }, true);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.page}>
            <BoundaryTool
                points={draft.points}
                closed={draft.closed}
                active={!saving}
                onChange={(points, closed) => setDraft({ points, closed })}
            />

            <motion.div
                className={styles.top}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: QUICK }}
                transition={SMOOTH}
            >
                <span className={styles.card}>
                    <IconButton
                        icon="arrowLeft"
                        label="Back"
                        tip={false}
                        onClick={() =>
                            navigate(zone ? { name: 'zone', zoneId: zone.id } : { name: 'zones' })
                        }
                    />
                </span>
                <form className={styles.search} data-invalid={notFound} onSubmit={search}>
                    {searching ? <Spinner size={14} /> : <Icon name="search" size={14} />}
                    <input
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setNotFound(false);
                        }}
                        placeholder="Find a place"
                        aria-label="Find a place"
                        aria-invalid={notFound}
                    />
                </form>
            </motion.div>

            <div className={styles.corner}>
                <ZoomControl />
                <div className={styles.bottom}>
                    <AnimatePresence>
                        {draft.points.length ? (
                            <motion.span
                                key="clear"
                                className={styles.card}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.9, transition: QUICK }}
                                transition={SMOOTH}
                            >
                                <IconButton
                                    icon="undo"
                                    label="Start over"
                                    disabled={saving}
                                    onClick={() => setDraft({ points: [], closed: false })}
                                />
                            </motion.span>
                        ) : null}
                        {draft.closed ? (
                            <motion.span
                                key="next"
                                initial={{ opacity: 0, y: 12 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 12, transition: QUICK }}
                                transition={SMOOTH}
                            >
                                <Button
                                    variant="primary"
                                    size="lg"
                                    iconAfter="arrowRight"
                                    loading={saving}
                                    onClick={() => void next()}
                                >
                                    Next
                                </Button>
                            </motion.span>
                        ) : null}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}
