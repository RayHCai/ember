import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { flyToPoint } from '../map/camera';
import { geocode, type GeocodeResult } from '../map/geocode';
import { useMap } from '../map/viewer';
import { centroid, polygonAreaKm2 } from '../sim/geo';
import type { LatLon, WatchZone } from '../sim/types';
import { autoFit, hash } from '../sim/world';
import { notify } from '../store/notifications';
import { navigate } from '../store/router';
import { useZones } from '../store/zones';
import { Button } from '../ui/Button';
import { CountUp } from '../ui/CountUp';
import panel from '../ui/panel.module.css';
import ui from '../ui/ui.module.css';
import { PRESETS } from './presets';
import type { Draft } from './SetupPage';
import styles from './Setup.module.css';

const HELP: { icon: GlyphName; text: string }[] = [
    { icon: 'pin', text: 'Click the map to drop boundary points' },
    { icon: 'check', text: 'Click the first point or press Enter to close' },
    { icon: 'edit', text: 'Drag points; drag a midpoint to add one' },
    { icon: 'close', text: 'Right-click a point to remove it' },
];

interface Props {
    zone: WatchZone | null;
    draft: Draft;
    setDraft: (d: Draft) => void;
}

export function BoundaryStep({ zone, draft, setDraft }: Props) {
    const viewer = useMap((s) => s.viewer);
    const source = useMap((s) => s.source);
    const createZone = useZones((s) => s.createZone);
    const setBoundary = useZones((s) => s.setBoundary);
    const rename = useZones((s) => s.rename);
    const [name, setName] = useState(zone?.name ?? '');
    const [region, setRegion] = useState(zone?.region ?? '');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<GeocodeResult[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [fitting, setFitting] = useState(false);
    const fits = useRef(0);

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

    const runAutoFit = () => {
        if (!draft.closed || fitting) return;
        fits.current += 1;
        const { from, to } = autoFit(draft.points, hash(name || 'zone') + fits.current);
        setFitting(true);
        const start = performance.now();
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1300;
        const tick = () => {
            const t = duration ? Math.min(1, (performance.now() - start) / duration) : 1;
            const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
            setDraft({
                points: from.map((p, i) => [
                    p[0] + (to[i]![0] - p[0]) * e,
                    p[1] + (to[i]![1] - p[1]) * e,
                ]),
                closed: true,
            });
            if (t < 1) requestAnimationFrame(tick);
            else {
                setFitting(false);
                notify(
                    'success',
                    'Fitted to the forest edge',
                    `${polygonAreaKm2(to).toFixed(1)} km² of forest detected from imagery and open data.`,
                );
            }
        };
        requestAnimationFrame(tick);
    };

    const proceed = () => {
        const trimmed = name.trim();
        if (!trimmed || !draft.closed) return;
        const where =
            region ||
            `${centroid(draft.points)
                .map((n) => n.toFixed(3))
                .join(', ')}`;
        if (!zone) {
            const id = createZone({ name: trimmed, region: where, boundary: draft.points });
            notify(
                'success',
                'Watch zone created',
                `${trimmed} is on the map. Next, place edge servers.`,
            );
            navigate({ name: 'setup', zoneId: id, step: 'servers' }, true);
            return;
        }
        if (trimmed !== zone.name) rename(zone.id, trimmed);
        if (draft.points !== zone.boundary) {
            setBoundary(zone.id, draft.points);
            notify(
                'info',
                'Boundary updated',
                'Recompute edge server placements for the new area.',
                zone,
            );
        }
        navigate({ name: 'setup', zoneId: zone.id, step: 'servers' }, true);
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

            <form className={styles.searchRow} onSubmit={search}>
                <label className={ui.field} style={{ flex: 1 }}>
                    <span className={ui.fieldLabel}>Address or place (optional)</span>
                    <span className={styles.searchInput}>
                        <Icon name="search" size={15} />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search to move the map"
                        />
                    </span>
                </label>
                <Button type="submit" size="md" loading={searching} disabled={!query.trim()}>
                    Find
                </Button>
            </form>
            <AnimatePresence>
                {results && results.length ? (
                    <motion.ul
                        className={styles.results}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
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

            <ul className={styles.help}>
                {HELP.map((h) => (
                    <li key={h.text}>
                        <Icon name={h.icon} size={13} /> {h.text}
                    </li>
                ))}
            </ul>

            <div className={styles.drawStats}>
                <div>
                    <span className={panel.muted}>Points</span>
                    <strong className="mono">{draft.points.length}</strong>
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
                    >
                        {draft.closed ? <Icon name="check" size={13} /> : null} {status}
                    </motion.span>
                </div>
            </div>

            <div className={styles.tools}>
                <Button
                    variant="soft"
                    icon="sparkle"
                    disabled={!draft.closed}
                    loading={fitting}
                    onClick={runAutoFit}
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
                    onClick={proceed}
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
