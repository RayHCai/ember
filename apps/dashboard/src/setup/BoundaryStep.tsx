import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/Icon';
import { flyToPoint } from '../map/camera';
import { geocode, type GeocodeResult } from '../map/geocode';
import { useMap } from '../map/viewer';
import { api } from '../api';
import { message } from '../api/client';
import { centroid, morphPair, polygonAreaKm2 } from '../model/geo';
import type { LatLon, ZoneView } from '../model/types';
import { latLng, ll } from '../model/zone';
import { createZone, updateZone } from '../store/actions';
import { notify } from '../store/notifications';
import { navigate } from '../store/router';
import { Button } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import { QUICK } from '../ui/motion';
import panel from '../ui/panel.module.css';
import ui from '../ui/ui.module.css';
import { PRESETS } from './presets';
import type { Draft } from './SetupPage';
import styles from './Setup.module.css';

const HELP: { input: string; text: string }[] = [
    { input: 'Click', text: 'Add a point' },
    { input: 'Enter', text: 'Close the shape' },
    { input: 'Drag', text: 'Move a point' },
    { input: 'Right-click', text: 'Remove a point' },
];

interface Props {
    zone: ZoneView | null;
    draft: Draft;
    setDraft: (d: Draft) => void;
}

export function BoundaryStep({ zone, draft, setDraft }: Props) {
    const viewer = useMap((s) => s.viewer);
    const source = useMap((s) => s.source);
    const [name, setName] = useState(zone?.name ?? '');
    const [region, setRegion] = useState(zone?.region ?? '');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<GeocodeResult[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [fitting, setFitting] = useState(false);
    const [saving, setSaving] = useState(false);
    const animation = useRef(0);
    useEffect(() => () => cancelAnimationFrame(animation.current), []);

    const area = draft.closed ? polygonAreaKm2(draft.points) : 0;
    const status =
        draft.points.length < 3
            ? `Drop ${3 - draft.points.length} more point${draft.points.length === 2 ? '' : 's'}`
            : draft.closed
              ? 'Boundary ready'
              : 'Close the shape to fill it';

    const search = async (e: FormEvent) => {
        e.preventDefault();
        if (!viewer || !query.trim()) return;
        setSearching(true);
        setSearchError(null);
        try {
            const found = await geocode(query.trim(), source?.id, viewer.scene);
            setResults(found);
            if (found.length === 0) setSearchError('No places matched that address.');
        } catch (err) {
            setSearchError(err instanceof Error ? err.message : String(err));
        } finally {
            setSearching(false);
        }
    };

    const goTo = (at: LatLon, heightM: number, label: string) => {
        if (viewer) void flyToPoint(viewer, at, heightM);
        if (!region) setRegion(label);
        setResults(null);
    };

    const morph = (from: LatLon[], to: LatLon[]) =>
        new Promise<void>((resolve) => {
            const [a, b] = morphPair(from, to);
            const start = performance.now();
            const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 0
                : 1100;
            const tick = () => {
                const t = duration ? Math.min(1, (performance.now() - start) / duration) : 1;
                const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
                setDraft({
                    points: a.map((p, i) => [
                        p[0] + (b[i]![0] - p[0]) * e,
                        p[1] + (b[i]![1] - p[1]) * e,
                    ]),
                    closed: true,
                });
                if (t < 1) animation.current = requestAnimationFrame(tick);
                else {
                    setDraft({ points: to, closed: true });
                    resolve();
                }
            };
            animation.current = requestAnimationFrame(tick);
        });

    const runAutoFit = async () => {
        if (!draft.closed || fitting) return;
        setFitting(true);
        try {
            const fit = await api.forestFit(draft.points.map(latLng));
            const to = fit.boundary.map(ll);
            await morph(draft.points, to);
            notify(
                'success',
                'Fitted to the vegetation edge',
                `${(fit.areaM2 / 1e6).toFixed(1)} km² of ${fit.classes.slice(0, 3).join(', ') || 'vegetation'}.`,
            );
        } catch (err) {
            notify('warning', 'Auto-fit found nothing to fit', message(err));
        } finally {
            setFitting(false);
        }
    };

    const proceed = async () => {
        const trimmed = name.trim();
        if (!trimmed || !draft.closed || saving) return;
        const where =
            region ||
            `${centroid(draft.points)
                .map((n) => n.toFixed(3))
                .join(', ')}`;
        setSaving(true);
        try {
            if (!zone) {
                const created = await createZone({
                    name: trimmed,
                    region: where,
                    boundary: draft.points,
                });
                if (!created) return;
                notify('success', 'Watch zone created', trimmed);
                navigate({ name: 'setup', zoneId: created.id, step: 'servers' }, true);
                return;
            }
            const boundaryChanged = draft.points !== zone.boundary;
            const ok = await updateZone(zone.id, {
                ...(trimmed !== zone.name ? { name: trimmed } : {}),
                ...(boundaryChanged ? { boundary: draft.points.map(latLng) } : {}),
                ...(region !== zone.region ? { region: region || null } : {}),
            });
            if (!ok) return;
            if (boundaryChanged)
                notify(
                    'info',
                    'Boundary updated',
                    'Recompute edge server placements for the new area.',
                    zone,
                );
            navigate({ name: 'setup', zoneId: zone.id, step: 'servers' }, true);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.stepBody}>
            <label className={ui.field}>
                <span className={ui.fieldLabel}>Zone name</span>
                <input
                    className={ui.input}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Eaton Canyon"
                    autoFocus={!zone}
                />
            </label>

            <div className={styles.place}>
                <form className={ui.field} onSubmit={search}>
                    <label className={ui.fieldLabel} htmlFor="place-search">
                        Find a place
                    </label>
                    <span className={styles.searchInput}>
                        <Icon name="search" size={14} />
                        <input
                            id="place-search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Address or place"
                        />
                        <Button
                            type="submit"
                            size="sm"
                            variant="ghost"
                            loading={searching}
                            disabled={!query.trim()}
                        >
                            Find
                        </Button>
                    </span>
                </form>
                <AnimatePresence>
                    {results && results.length ? (
                        <motion.ul
                            className={styles.results}
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={QUICK}
                        >
                            {results.map((r) => (
                                <li key={`${r.lat},${r.lon}`}>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            goTo(
                                                [r.lat, r.lon],
                                                Math.min(60_000, Math.max(8_000, r.extentM * 2.4)),
                                                r.name.split(',').slice(0, 3).join(','),
                                            )
                                        }
                                    >
                                        <Icon name="pin" size={13} /> {r.name}
                                    </button>
                                </li>
                            ))}
                        </motion.ul>
                    ) : null}
                </AnimatePresence>
                {searchError ? <p className={styles.error}>{searchError}</p> : null}
                <div className={styles.chips}>
                    {PRESETS.map((p) => (
                        <button
                            key={p.name}
                            type="button"
                            className={styles.chip}
                            onClick={() => goTo(p.at, p.heightM, p.region)}
                        >
                            {p.name}
                        </button>
                    ))}
                </div>
            </div>

            <div className={styles.draw}>
                <div className={styles.drawStats}>
                    <div>
                        <span className={panel.muted}>Points</span>
                        <strong>{draft.points.length}</strong>
                    </div>
                    <div>
                        <span className={panel.muted}>Area</span>
                        <strong>
                            <CountUp value={area} decimals={1} suffix=" km²" duration={0.5} />
                        </strong>
                    </div>
                    <div className={styles.drawStatus} data-ready={draft.closed}>
                        <motion.span
                            key={status}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={QUICK}
                        >
                            {draft.closed ? <Icon name="check" size={12} /> : null} {status}
                        </motion.span>
                    </div>
                </div>
                <ul className={styles.help}>
                    {HELP.map((h) => (
                        <li key={h.input}>
                            <kbd className={ui.kbd}>{h.input}</kbd> {h.text}
                        </li>
                    ))}
                </ul>
            </div>

            <div className={styles.tools}>
                <Button
                    icon="sparkle"
                    size="sm"
                    disabled={!draft.closed}
                    loading={fitting}
                    onClick={() => void runAutoFit()}
                >
                    {fitting ? 'Detecting forest' : 'Auto-fit to forest'}
                </Button>
                <Button
                    variant="ghost"
                    icon="undo"
                    size="sm"
                    disabled={draft.points.length === 0 || fitting}
                    onClick={() =>
                        setDraft(
                            draft.closed
                                ? { points: draft.points, closed: false }
                                : { points: draft.points.slice(0, -1), closed: false },
                        )
                    }
                >
                    Undo
                </Button>
                <Button
                    variant="ghost"
                    icon="trash"
                    size="sm"
                    disabled={draft.points.length === 0 || fitting}
                    onClick={() => setDraft({ points: [], closed: false })}
                >
                    Clear
                </Button>
            </div>

            <div className={styles.footer}>
                <Button
                    variant="primary"
                    size="lg"
                    block
                    iconAfter="arrowRight"
                    disabled={!name.trim() || !draft.closed || fitting}
                    loading={saving}
                    onClick={() => void proceed()}
                >
                    {zone ? 'Save and recompute servers' : 'Continue to edge servers'}
                </Button>
                {!name.trim() && draft.closed ? (
                    <p className={panel.muted}>Name the zone to continue.</p>
                ) : null}
            </div>

            {fitting
                ? createPortal(<div className={styles.sweep} aria-hidden />, document.body)
                : null}
        </div>
    );
}
