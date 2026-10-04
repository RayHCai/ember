import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../icons/Icon';
import type { WatchZone } from '../sim/types';
import { riskCounts } from '../sim/world';
import { useUi } from '../store/ui';
import { Button } from '../ui/Button';
import { minutes } from '../ui/format';
import panel from '../ui/panel.module.css';
import operator from '../zone/OperatorPanel.module.css';
import styles from './Live.module.css';
import { setRoadState } from './poller';
import { useLive } from './store';

/** The live zone's operator panel: what Ember sees, and the two things an operator can do here. */
export function LivePanel({ zone }: { zone: WatchZone }) {
    const tool = useLive((s) => s.tool);
    const setTool = useLive((s) => s.setTool);
    const select = useUi((s) => s.select);
    const setSuggestions = useUi((s) => s.setSuggestions);

    const online = zone.servers.filter((s) => s.live?.online).length;
    const assigned = zone.responders.filter((r) => r.device === 'assigned').length;
    const impacted = zone.civilianPlan?.impacts.filter((c) => c.urgency > 0) ?? [];
    const attackZones = zone.responderPlan?.dropSites.length ?? 0;
    const { atRisk, onFire } = riskCounts(zone);
    const closedRoads = (zone.roads ?? []).filter((r) => r.state !== 'open');
    const haPerCell = (zone.grid.cellM * zone.grid.cellM) / 10_000;

    return (
        <motion.aside
            className={`${panel.panel} ${operator.panel}`}
            initial={{ opacity: 0, x: -36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -36 }}
            transition={{ type: 'spring', stiffness: 260, damping: 30, delay: 0.05 }}
        >
            <div className={panel.section}>
                <div className={operator.metrics}>
                    <button
                        type="button"
                        className={operator.metric}
                        onClick={() =>
                            zone.servers[0] && select({ kind: 'server', id: zone.servers[0].id })
                        }
                    >
                        <span className={panel.muted}>Edge servers</span>
                        <strong className={operator.metricValue}>{zone.servers.length}</strong>
                        <span className={panel.muted}>{online} reporting</span>
                    </button>
                    <div className={operator.metric}>
                        <span className={panel.muted}>Fire</span>
                        <strong className={operator.metricValue}>
                            {Math.round(onFire * haPerCell)}
                        </strong>
                        <span className={panel.muted}>
                            {onFire
                                ? 'ha burning'
                                : atRisk
                                  ? `${Math.round(atRisk * haPerCell)} ha at risk`
                                  : 'no fire seen'}
                        </span>
                    </div>
                    <div className={operator.metric}>
                        <span className={panel.muted}>Responders</span>
                        <strong className={operator.metricValue}>{zone.responders.length}</strong>
                        <span className={panel.muted}>{assigned} assigned</span>
                    </div>
                    <div className={operator.metric}>
                        <span className={panel.muted}>Civilian areas</span>
                        <strong className={operator.metricValue}>{zone.communities.length}</strong>
                        <span className={panel.muted}>{impacted.length} in the fire's path</span>
                    </div>
                </div>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="target" size={13} /> Map tools
                    </span>
                </div>
                <div className={panel.stack}>
                    <Button
                        key={tool === 'fire' ? 'cancel-fire' : 'fire'}
                        variant={tool === 'fire' ? 'secondary' : 'primary'}
                        icon={tool === 'fire' ? 'close' : 'flame'}
                        block
                        onClick={() => setTool(tool === 'fire' ? null : 'fire')}
                    >
                        {tool === 'fire' ? 'Cancel' : 'Start a fire here'}
                    </Button>
                    <Button
                        key={tool === 'road' ? 'cancel-road' : 'road'}
                        icon={tool === 'road' ? 'close' : 'route'}
                        block
                        onClick={() => setTool(tool === 'road' ? null : 'road')}
                    >
                        {tool === 'road' ? 'Cancel' : 'Block or reopen a road'}
                    </Button>
                </div>
                <AnimatePresence initial={false}>
                    {tool ? (
                        <motion.div
                            key={tool}
                            className={`${panel.callout} ${styles.armed}`}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                        >
                            <Icon name={tool === 'fire' ? 'flame' : 'route'} size={16} />
                            <span>
                                <strong>
                                    {tool === 'fire' ? 'Click the map' : 'Click a road'}
                                </strong>
                                {tool === 'fire'
                                    ? 'A simulated fire starts there. Ember verifies it, opens an incident and plans within about 30 s.'
                                    : 'An open road becomes blocked; a blocked one reopens. Esc cancels.'}
                            </span>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="route" size={13} /> Plan
                    </span>
                    {zone.civilianPlan ? (
                        <button
                            type="button"
                            className={operator.view}
                            onClick={() => setSuggestions(true)}
                        >
                            Show on map
                        </button>
                    ) : null}
                </div>
                {zone.civilianPlan ? (
                    <ul className={panel.list}>
                        {impacted.map((c) => (
                            <li key={c.communityId}>
                                <button
                                    type="button"
                                    className={panel.item}
                                    onClick={() => select({ kind: 'community', id: c.communityId })}
                                >
                                    <span className={panel.itemIcon} data-tone="flame">
                                        <Icon name="home" size={15} />
                                    </span>
                                    <span className={panel.itemText}>
                                        <strong>{c.name}</strong>
                                        <span>{c.population.toLocaleString()} residents</span>
                                    </span>
                                    <span
                                        className={panel.tag}
                                        data-tone={c.urgency > 0.5 ? 'fire' : 'risk'}
                                    >
                                        {c.arrivalMin === null ? 'Clear' : minutes(c.arrivalMin)}
                                    </span>
                                </button>
                            </li>
                        ))}
                        <li className={panel.muted}>
                            {impacted.length ? '' : 'No civilian area in the forecast. '}
                            {attackZones
                                ? `${attackZones} attack zone${attackZones === 1 ? '' : 's'} for responders.`
                                : 'No attack zones.'}
                        </li>
                    </ul>
                ) : (
                    <p className={panel.muted}>
                        No plan yet. Ember plans when a fire is confirmed or conditions change.
                    </p>
                )}
            </div>

            <div className={panel.section}>
                <div className={panel.sectionHead}>
                    <span className={panel.sectionTitle}>
                        <Icon name="alert" size={13} /> Roads
                    </span>
                    <span className={panel.muted}>{zone.roads?.length ?? 0} mapped</span>
                </div>
                <ul className={panel.list}>
                    {closedRoads.map((r) => (
                        <li key={r.id} className={panel.item}>
                            <span className={panel.itemIcon} data-tone="flame">
                                <Icon name="route" size={15} />
                            </span>
                            <span className={panel.itemText}>
                                <strong>{r.name ?? 'Unnamed road'}</strong>
                                <span>{r.state}</span>
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void setRoadState(r.id, r.name, 'open')}
                            >
                                Reopen
                            </Button>
                        </li>
                    ))}
                    {closedRoads.length === 0 ? (
                        <li className={panel.muted}>Every road is open.</li>
                    ) : null}
                </ul>
            </div>

            <div className={panel.section}>
                <p className={panel.muted}>
                    Ember's operator agent runs scans, plans and drafts here. Simulator actions are
                    off on this zone; civilian texts still need your approval.
                </p>
            </div>
        </motion.aside>
    );
}
