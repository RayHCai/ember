import { motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { getTelemetry, isAirborne, MODE_LABEL } from '../live/telemetry';
import { flyToPoint } from '../map/camera';
import { useMap } from '../map/viewer';
import type { ZoneView } from '../model/types';
import { hectares, ll } from '../model/zone';
import { assignPlacement, releaseServer, removePlacement, stopScan } from '../store/actions';
import { useUi, type Picked } from '../store/ui';
import { useZones } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { ago, minutes } from '../ui/format';
import { QUICK, SMOOTH, SNAP } from '../ui/motion';
import panel from '../ui/panel.module.css';
import ui from '../ui/ui.module.css';
import { useNow } from '../ui/useNow';
import styles from './Inspector.module.css';

function Meter({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'bad' }) {
    return (
        <span className={styles.meter} data-tone={tone}>
            <motion.span
                animate={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                transition={SMOOTH}
            />
        </span>
    );
}

function Shell({
    icon,
    tone,
    title,
    subtitle,
    tag,
    children,
}: {
    icon: GlyphName;
    tone?: 'ink' | 'pink' | 'fire';
    title: string;
    subtitle: string;
    tag?: ReactNode;
    children: ReactNode;
}) {
    const select = useUi((s) => s.select);
    return (
        <motion.section
            layout
            className={`${panel.panel} ${styles.inspector}`}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24, transition: QUICK }}
            transition={{ ...SMOOTH, layout: SNAP }}
        >
            <header className={styles.head}>
                <span className={panel.itemIcon} data-tone={tone}>
                    <Icon name={icon} size={16} />
                </span>
                <div className={styles.headText}>
                    <strong>{title}</strong>
                    <span>{subtitle}</span>
                </div>
                {tag}
                <IconButton
                    icon="close"
                    label="Close inspector"
                    tip={false}
                    onClick={() => select(null)}
                />
            </header>
            <div className={styles.body}>{children}</div>
        </motion.section>
    );
}

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

function PendingSite({ zone, id }: { zone: ZoneView; id: string }) {
    const site = zone.servers.find((s) => s.id === id);
    const unassigned = useZones((s) => s.unassigned);
    const select = useUi((s) => s.select);
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);
    if (!site) return null;
    return (
        <Shell
            icon="server"
            tone="pink"
            title={`Site ${site.name}`}
            subtitle={`${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}`}
            tag={
                <span className={panel.tag} data-tone="pink">
                    Planned
                </span>
            }
        >
            <dl className={panel.kv}>
                <div>
                    <dt>Radius</dt>
                    <dd>{km(site.radiusM)}</dd>
                </div>
                <div>
                    <dt>Waiting servers</dt>
                    <dd>{unassigned.length}</dd>
                </div>
            </dl>
            <div className={styles.actions}>
                <select
                    className={ui.input}
                    aria-label="Edge server for this site"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                    disabled={unassigned.length === 0}
                >
                    <option value="">
                        {unassigned.length ? 'Choose an edge server' : 'No edge servers waiting'}
                    </option>
                    {unassigned.map((e) => (
                        <option key={e.edgeServerId} value={e.edgeServerId}>
                            {e.edgeServerId}
                            {e.live?.online ? '' : ' (offline)'}
                        </option>
                    ))}
                </select>
                <Button
                    variant="primary"
                    block
                    loading={busy}
                    disabled={!choice}
                    onClick={async () => {
                        setBusy(true);
                        const ok = await assignPlacement(zone.id, site.id, choice);
                        setBusy(false);
                        select(ok ? { kind: 'server', id: choice } : null);
                    }}
                >
                    Deploy here
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={() => {
                        void removePlacement(zone.id, site.id);
                        select(null);
                    }}
                >
                    Remove site
                </Button>
            </div>
        </Shell>
    );
}

function ServerInfo({ zone, id }: { zone: ZoneView; id: string }) {
    const now = useNow(1000);
    const select = useUi((s) => s.select);
    const server = zone.servers.find((s) => s.id === id);
    if (!server) return null;
    if (server.status === 'pending') return <PendingSite zone={zone} id={id} />;
    const live = server.edge?.live ?? null;
    const drones = zone.drones.filter((d) => d.serverId === server.id);
    const seenS = live ? Math.max(0, Math.round((now - Date.parse(live.lastSeen)) / 1000)) : null;

    return (
        <Shell
            icon="server"
            tone="ink"
            title={`Edge server ${server.name}`}
            subtitle={`${server.lat.toFixed(4)}, ${server.lon.toFixed(4)}`}
            tag={
                <span className={panel.tag} data-tone={server.online ? 'ok' : undefined}>
                    {server.online ? 'Online' : server.online === false ? 'Offline' : 'Unknown'}
                </span>
            }
        >
            <dl className={panel.kv}>
                <div>
                    <dt>Drones connected</dt>
                    <dd>{live ? `${live.connectedDrones} of ${live.drones}` : '—'}</dd>
                    {live && live.drones ? (
                        <Meter value={(100 * live.connectedDrones) / live.drones} tone="ok" />
                    ) : null}
                </div>
                <div>
                    <dt>Last update</dt>
                    <dd>{seenS === null ? '—' : seenS < 2 ? 'just now' : `${seenS}s ago`}</dd>
                </div>
                <div>
                    <dt>Radius</dt>
                    <dd>{km(server.radiusM)}</dd>
                </div>
                <div>
                    <dt>Run</dt>
                    <dd>{live?.run ? live.run.state : 'idle'}</dd>
                </div>
                <div>
                    <dt>Connected since</dt>
                    <dd>{live ? ago(Date.parse(live.connectedAt), now) : '—'}</dd>
                </div>
                <div>
                    <dt>Address</dt>
                    <dd className="mono">{server.edge?.url.replace(/^https?:\/\//, '')}</dd>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Edge server ID</dt>
                    <dd className="mono">{server.id}</dd>
                </div>
            </dl>
            <div className={styles.subhead}>Paired drones · {drones.length}</div>
            <ul className={panel.list}>
                {drones.map((d) => {
                    const t = getTelemetry(d.id);
                    return (
                        <li key={d.id}>
                            <button
                                type="button"
                                className={panel.item}
                                onClick={() => select({ kind: 'drone', id: d.id })}
                            >
                                <span className={panel.itemIcon}>
                                    <Icon name="drone" size={15} />
                                </span>
                                <span className={panel.itemText}>
                                    <strong>{d.name}</strong>
                                    <span>{t ? MODE_LABEL[t.mode] : 'No position'}</span>
                                </span>
                                <span className={panel.muted}>
                                    {t ? `${Math.round(t.batteryPct)}%` : '—'}
                                </span>
                            </button>
                        </li>
                    );
                })}
                {drones.length === 0 ? <li className={panel.muted}>No drones paired</li> : null}
            </ul>
            <div className={styles.actions}>
                <Button
                    size="sm"
                    icon="trash"
                    variant="ghost"
                    onClick={() => {
                        void releaseServer(zone.id, server.id);
                        select(null);
                    }}
                >
                    Remove from zone
                </Button>
            </div>
        </Shell>
    );
}

function DroneInfo({ zone, id }: { zone: ZoneView; id: string }) {
    const now = useNow(250);
    const viewer = useMap((s) => s.viewer);
    const select = useUi((s) => s.select);
    const drone = zone.drones.find((d) => d.id === id);
    if (!drone) return null;
    const t = getTelemetry(id);
    const server = zone.servers.find((s) => s.id === drone.serverId);
    const flying = isAirborne(t);

    return (
        <Shell
            icon="drone"
            tone={flying ? 'fire' : undefined}
            title={drone.name}
            subtitle={drone.kind === 'simulated' ? 'Simulated drone' : 'Drone'}
            tag={
                <span className={panel.tag} data-tone={flying ? 'fire' : t ? 'ok' : undefined}>
                    {t ? MODE_LABEL[t.mode] : 'No position'}
                </span>
            }
        >
            {t ? (
                <>
                    <div className={styles.battery}>
                        <div className={`${panel.row} ${panel.spread}`}>
                            <span className={panel.muted}>Battery</span>
                            <strong>{Math.round(t.batteryPct)}%</strong>
                        </div>
                        <Meter
                            value={t.batteryPct}
                            tone={t.batteryPct < 30 ? 'bad' : t.batteryPct < 55 ? 'warn' : 'ok'}
                        />
                    </div>
                    <dl className={panel.kv}>
                        <div>
                            <dt>Altitude</dt>
                            <dd>{Math.round(t.altM)} m</dd>
                        </div>
                        <div>
                            <dt>Speed</dt>
                            <dd>{t.speedMs.toFixed(1)} m/s</dd>
                        </div>
                        <div>
                            <dt>Heading</dt>
                            <dd>{Math.round(t.headingDeg)}°</dd>
                        </div>
                        <div>
                            <dt>Last seen</dt>
                            <dd>{Math.max(0, Math.round((now - t.lastSeenAt) / 1000))}s ago</dd>
                        </div>
                        <div style={{ gridColumn: 'span 2' }}>
                            <dt>Last reported position</dt>
                            <dd>
                                {t.lat.toFixed(5)}, {t.lon.toFixed(5)}
                            </dd>
                        </div>
                    </dl>
                </>
            ) : (
                <p className={panel.muted}>drone-info has no report from this drone yet.</p>
            )}
            <dl className={panel.kv}>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Device ID</dt>
                    <dd className="mono">{drone.id}</dd>
                </div>
            </dl>
            {server ? (
                <button
                    type="button"
                    className={panel.item}
                    onClick={() => select({ kind: 'server', id: server.id })}
                >
                    <span className={panel.itemIcon} data-tone="ink">
                        <Icon name="server" size={15} />
                    </span>
                    <span className={panel.itemText}>
                        <strong>Edge server {server.name}</strong>
                        <span>Paired {ago(drone.registeredAt, now)}</span>
                    </span>
                    <Icon name="chevronRight" size={12} />
                </button>
            ) : null}
            <div className={styles.actions}>
                <Button
                    size="sm"
                    icon="target"
                    disabled={!t}
                    onClick={() =>
                        t && viewer && void flyToPoint(viewer, [t.lat, t.lon], 3500, 1.2)
                    }
                >
                    Locate
                </Button>
                {flying && zone.scan ? (
                    <Button
                        size="sm"
                        icon="stop"
                        onClick={() => void stopScan(zone.id, zone.scan!.runId)}
                    >
                        Recall fleet
                    </Button>
                ) : null}
            </div>
        </Shell>
    );
}

function RiskInfo({ zone, id }: { zone: ZoneView; id: string }) {
    const openBlast = useUi((s) => s.openBlast);
    const z = zone.riskZones.find((x) => x.id === id);
    if (!z) return null;
    const fire = z.risk === 'on_fire';
    const names = z.droneIds.map((d) => zone.drones.find((x) => x.id === d)?.name ?? d);
    return (
        <Shell
            icon={fire ? 'alert' : 'tree'}
            tone="fire"
            title={fire ? 'Active fire' : 'At-risk vegetation'}
            subtitle={`${z.center.lat.toFixed(4)}, ${z.center.lng.toFixed(4)}`}
            tag={
                <span className={panel.tag} data-tone={fire ? 'fire' : 'risk'}>
                    {Math.round(z.confidence * 100)}% sure
                </span>
            }
        >
            <dl className={panel.kv}>
                <div>
                    <dt>Area</dt>
                    <dd>{hectares(z.areaM2 / 10_000)} ha</dd>
                </div>
                <div>
                    <dt>Detections</dt>
                    <dd>{z.detections}</dd>
                </div>
                <div>
                    <dt>First seen</dt>
                    <dd>{ago(Date.parse(z.firstSeenAt))}</dd>
                </div>
                <div>
                    <dt>Last seen</dt>
                    <dd>{ago(Date.parse(z.observedAt))}</dd>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Seen by</dt>
                    <dd>{names.join(', ')}</dd>
                </div>
            </dl>
            {fire ? (
                <Button
                    variant="primary"
                    icon="megaphone"
                    block
                    onClick={() =>
                        openBlast({
                            audience: 'responders',
                            priority: 'urgent',
                            title: 'Fire confirmed',
                            body: `Drones confirmed ${hectares(z.areaM2 / 10_000)} ha burning at ${z.center.lat.toFixed(4)}, ${z.center.lng.toFixed(4)} in ${zone.name}.`,
                            area: 'zone',
                        })
                    }
                >
                    Alert responders
                </Button>
            ) : null}
        </Shell>
    );
}

function CommunityInfo({ zone, id }: { zone: ZoneView; id: string }) {
    const openBlast = useUi((s) => s.openBlast);
    const area = zone.surroundings?.civilianAreas.find((a) => a.id === id);
    const impact = zone.plan?.civilianImpacts.find((c) => c.civilianAreaId === id);
    const route = zone.plan?.evacuationRoutes.find((r) => r.civilianAreaId === id);
    if (!area) return null;
    const dest = route?.destination?.safeZoneId
        ? zone.surroundings?.safeZones.find((s) => s.id === route.destination!.safeZoneId)
        : null;
    const destName = dest?.name ?? (route?.destination ? 'the road exit' : 'the nearest safe zone');
    const tone =
        impact?.severity === 'immediate' || impact?.severity === 'warning'
            ? 'fire'
            : impact?.severity === 'watch'
              ? 'risk'
              : 'ok';
    return (
        <Shell
            icon="home"
            title={area.name}
            subtitle={`${area.population.toLocaleString()} residents`}
            tag={
                <span className={panel.tag} data-tone={tone}>
                    {impact ? impact.severity : 'not planned'}
                </span>
            }
        >
            <dl className={panel.kv}>
                <div>
                    <dt>Predicted fire arrival</dt>
                    <dd>
                        {!impact || impact.impactMin === null
                            ? `Not in ${minutes(zone.plan?.horizonMin ?? 0)}`
                            : impact.impactMin <= 0
                              ? 'Burning now'
                              : minutes(impact.impactMin)}
                    </dd>
                </div>
                <div>
                    <dt>Area exposed</dt>
                    <dd>{impact ? `${Math.round(impact.exposedFraction * 100)}%` : '—'}</dd>
                </div>
                {route ? (
                    <>
                        <div>
                            <dt>Evacuation route</dt>
                            <dd>
                                {route.status === 'no_safe_route' ? 'No safe route' : route.status}
                            </dd>
                        </div>
                        <div>
                            <dt>Clearance</dt>
                            <dd>
                                {route.clearanceMin === null
                                    ? 'Fire never reaches it'
                                    : minutes(route.clearanceMin)}
                            </dd>
                        </div>
                        {route.status !== 'no_safe_route' ? (
                            <>
                                <div>
                                    <dt>Distance</dt>
                                    <dd>{km(route.distanceM)}</dd>
                                </div>
                                <div>
                                    <dt>Travel time</dt>
                                    <dd>{Math.round(route.etaMin)} min</dd>
                                </div>
                                <div style={{ gridColumn: 'span 2' }}>
                                    <dt>To</dt>
                                    <dd>{destName}</dd>
                                </div>
                            </>
                        ) : null}
                    </>
                ) : null}
            </dl>
            {route && route.status !== 'no_safe_route' ? (
                <Button
                    variant="primary"
                    icon="megaphone"
                    block
                    onClick={() =>
                        openBlast({
                            audience: 'civilians',
                            priority: 'critical',
                            title: `Evacuate ${area.name}`,
                            body: `Ember alert: a wildfire is moving toward ${area.name}. Evacuate now toward ${destName} by the marked route. Reply SAFE once you are out.`,
                            area: 'near_fire',
                        })
                    }
                >
                    Draft evacuation text
                </Button>
            ) : null}
        </Shell>
    );
}

function AttackZoneInfo({ zone, id }: { zone: ZoneView; id: string }) {
    const openBlast = useUi((s) => s.openBlast);
    const a = zone.plan?.attackZones.find((x) => x.id === id);
    if (!a) return null;
    return (
        <Shell
            icon="target"
            title={`Attack zone #${a.rank}`}
            subtitle={`${a.tactic} attack · score ${Math.round(a.score * 100)}`}
        >
            <dl className={panel.kv}>
                <div>
                    <dt>Working radius</dt>
                    <dd>{km(a.radiusM)}</dd>
                </div>
                <div>
                    <dt>Fire arrives</dt>
                    <dd>{minutes(Math.max(0, a.fireArrivalMin))}</dd>
                </div>
                <div>
                    <dt>Access from station</dt>
                    <dd>
                        {a.accessMin === null
                            ? 'No station known'
                            : `${Math.round(a.accessMin)} min`}
                    </dd>
                </div>
                <div>
                    <dt>Spread rate</dt>
                    <dd>{a.spreadRateMpm.toFixed(1)} m/min</dd>
                </div>
                <div>
                    <dt>Protects</dt>
                    <dd>{a.protectedPopulation.toLocaleString()} people</dd>
                </div>
                <div>
                    <dt>Land protected</dt>
                    <dd>{hectares(a.protectedAreaHa)} ha</dd>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Drop site</dt>
                    <dd>
                        {a.dropSite.lat.toFixed(5)}, {a.dropSite.lng.toFixed(5)}
                    </dd>
                </div>
            </dl>
            <Button
                icon="megaphone"
                block
                onClick={() =>
                    openBlast({
                        audience: 'responders',
                        priority: 'urgent',
                        title: `Stage at attack zone ${a.rank}`,
                        body: `${a.tactic === 'direct' ? 'Work the fire edge' : 'Cut line ahead of the front'} within ${km(a.radiusM)} of ${a.center.lat.toFixed(4)}, ${a.center.lng.toFixed(4)}. Drop site ${a.dropSite.lat.toFixed(4)}, ${a.dropSite.lng.toFixed(4)}. Fire expected in ${minutes(Math.max(0, a.fireArrivalMin))}.`,
                        area: 'zone',
                    })
                }
            >
                Send to responders
            </Button>
        </Shell>
    );
}

function PlaceInfo({ zone, id, kind }: { zone: ZoneView; id: string; kind: 'safe' | 'station' }) {
    const viewer = useMap((s) => s.viewer);
    const place =
        kind === 'safe'
            ? zone.surroundings?.safeZones.find((s) => s.id === id)
            : zone.surroundings?.stations.find((s) => s.id === id);
    if (!place) return null;
    const routes =
        kind === 'safe'
            ? (zone.plan?.evacuationRoutes.filter((r) => r.destination?.safeZoneId === id) ?? [])
            : [];
    const areas = routes
        .map((r) => zone.surroundings?.civilianAreas.find((a) => a.id === r.civilianAreaId)?.name)
        .filter(Boolean);
    const capacity = 'capacity' in place ? (place.capacity as number | null) : null;
    return (
        <Shell
            icon={kind === 'safe' ? 'shield' : 'flame'}
            title={place.name}
            subtitle={kind === 'safe' ? 'Safe zone' : 'Responder station'}
        >
            <dl className={panel.kv}>
                {kind === 'safe' ? (
                    <div>
                        <dt>Capacity</dt>
                        <dd>{capacity ?? 'Unknown'}</dd>
                    </div>
                ) : null}
                <div style={{ gridColumn: kind === 'safe' ? undefined : 'span 2' }}>
                    <dt>Position</dt>
                    <dd>
                        {place.location.lat.toFixed(4)}, {place.location.lng.toFixed(4)}
                    </dd>
                </div>
            </dl>
            {kind === 'safe' ? (
                <p className={panel.muted}>
                    {areas.length
                        ? `Receiving ${areas.join(', ')}`
                        : 'No evacuation route ends here'}
                </p>
            ) : null}
            <Button
                size="sm"
                icon="target"
                onClick={() => viewer && void flyToPoint(viewer, ll(place.location), 4000, 1.2)}
            >
                Locate
            </Button>
        </Shell>
    );
}

export function Inspector({ zone, picked }: { zone: ZoneView; picked: Picked }) {
    switch (picked.kind) {
        case 'server':
            return <ServerInfo zone={zone} id={picked.id} />;
        case 'drone':
            return <DroneInfo zone={zone} id={picked.id} />;
        case 'risk':
            return <RiskInfo zone={zone} id={picked.id} />;
        case 'community':
            return <CommunityInfo zone={zone} id={picked.id} />;
        case 'drop':
            return <AttackZoneInfo zone={zone} id={picked.id} />;
        case 'safe':
        case 'station':
            return <PlaceInfo zone={zone} id={picked.id} kind={picked.kind} />;
    }
}
