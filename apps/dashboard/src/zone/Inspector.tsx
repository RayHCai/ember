import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { flyToPoint } from '../map/camera';
import { useMap } from '../map/viewer';
import { getTelemetry } from '../sim/live';
import { stopScan } from '../sim/scan';
import type { DroneTelemetry, WatchZone } from '../sim/types';
import { notify } from '../store/notifications';
import { useUi, type Picked } from '../store/ui';
import { useZones } from '../store/zones';
import { Button, IconButton } from '../ui/Button';
import { ago, minutes } from '../ui/format';
import panel from '../ui/panel.module.css';
import { useNow } from '../ui/useNow';
import styles from './Inspector.module.css';

const STATE_LABEL: Record<DroneTelemetry['state'], string> = {
    docked: 'Docked',
    charging: 'Charging',
    launching: 'Launching',
    scanning: 'Scanning',
    returning: 'Returning',
};

function Meter({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'bad' }) {
    return (
        <span className={styles.meter} data-tone={tone}>
            <motion.span
                animate={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20 }}
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
    tone?: string;
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
            initial={{ opacity: 0, x: 40, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.98, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
        >
            <header className={styles.head}>
                <motion.span
                    className={styles.headIcon}
                    data-tone={tone}
                    initial={{ rotate: -25, scale: 0.6 }}
                    animate={{ rotate: 0, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 14 }}
                >
                    <Icon name={icon} size={20} />
                </motion.span>
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

function ServerView({ zone, id }: { zone: WatchZone; id: string }) {
    const now = useNow(1000);
    const deployServer = useZones((s) => s.deployServer);
    const select = useUi((s) => s.select);
    const server = zone.servers.find((s) => s.id === id);
    if (!server) return null;
    const h = server.health;
    const drones = zone.drones.filter((d) => d.serverId === server.id);
    const pending = server.status === 'pending';
    const jitter = (n: number, spread: number) => Math.round(n + Math.sin(now / 1700 + n) * spread);

    return (
        <Shell
            icon="server"
            tone={pending ? 'pink' : 'ink'}
            title={`Edge server ${server.name}`}
            subtitle={`${server.lat.toFixed(4)}, ${server.lon.toFixed(4)}`}
            tag={
                <span className={panel.tag} data-tone={pending ? 'pink' : 'ok'}>
                    {pending ? 'Pending' : 'Online'}
                </span>
            }
        >
            {pending ? (
                <div className={panel.callout} data-tone="pink">
                    <Icon name="info" size={16} />
                    <span>
                        <strong>Suggested placement</strong>
                        Deploy it to bring its {server.radiusM / 1000} km connectivity radius
                        online.
                    </span>
                </div>
            ) : (
                <>
                    <dl className={panel.kv}>
                        <div>
                            <dt>CPU</dt>
                            <dd>{jitter(h.cpuPct, 4)}%</dd>
                            <Meter value={jitter(h.cpuPct, 4)} />
                        </div>
                        <div>
                            <dt>Memory</dt>
                            <dd>{h.memoryPct}%</dd>
                            <Meter value={h.memoryPct} />
                        </div>
                        <div>
                            <dt>Temperature</dt>
                            <dd>{h.temperatureC} °C</dd>
                            <Meter
                                value={(h.temperatureC / 60) * 100}
                                tone={h.temperatureC > 42 ? 'warn' : 'ok'}
                            />
                        </div>
                        <div>
                            <dt>Latency to primary</dt>
                            <dd>{jitter(h.latencyMs, 3)} ms</dd>
                            <Meter value={(h.latencyMs / 80) * 100} tone="ok" />
                        </div>
                        <div>
                            <dt>Uptime</dt>
                            <dd>
                                {Math.floor(h.uptimeH / 24)}d {h.uptimeH % 24}h
                            </dd>
                        </div>
                        <div>
                            <dt>Power</dt>
                            <dd style={{ textTransform: 'capitalize' }}>{h.power}</dd>
                        </div>
                        <div>
                            <dt>Radius</dt>
                            <dd>{(server.radiusM / 1000).toFixed(1)} km</dd>
                        </div>
                        <div>
                            <dt>Firmware</dt>
                            <dd>{h.firmware}</dd>
                        </div>
                    </dl>
                    <div className={styles.subhead}>Connected drones · {drones.length}</div>
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
                                        <span className={panel.itemIcon} data-tone="flame">
                                            <Icon name="drone" size={15} />
                                        </span>
                                        <span className={panel.itemText}>
                                            <strong>{d.name}</strong>
                                            <span>{t ? STATE_LABEL[t.state] : 'Unknown'}</span>
                                        </span>
                                        <span className="mono" style={{ fontSize: 12 }}>
                                            {t?.batteryPct ?? '—'}%
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                        {drones.length === 0 ? (
                            <li className={panel.muted}>No drones paired here yet.</li>
                        ) : null}
                    </ul>
                </>
            )}
            <div className={styles.actions}>
                {pending ? (
                    <Button
                        variant="primary"
                        icon="server"
                        block
                        onClick={() => deployServer(zone.id, server.id)}
                    >
                        Deploy this server
                    </Button>
                ) : (
                    <>
                        <Button
                            size="sm"
                            icon="signal"
                            onClick={() =>
                                notify(
                                    'success',
                                    `${server.name} replied`,
                                    `Round trip ${h.latencyMs + 3} ms over the mesh.`,
                                    zone,
                                )
                            }
                        >
                            Ping
                        </Button>
                        <Button
                            size="sm"
                            icon="refresh"
                            onClick={() =>
                                notify(
                                    'info',
                                    `Restarting ${server.name}`,
                                    'Its drones keep flying on the neighbouring servers.',
                                    zone,
                                )
                            }
                        >
                            Restart
                        </Button>
                    </>
                )}
            </div>
        </Shell>
    );
}

function DroneView({ zone, id }: { zone: WatchZone; id: string }) {
    const now = useNow(200);
    const viewer = useMap((s) => s.viewer);
    const select = useUi((s) => s.select);
    const drone = zone.drones.find((d) => d.id === id);
    const t = getTelemetry(id);
    if (!drone || !t) return null;
    const server = zone.servers.find((s) => s.id === drone.serverId);
    const flying = t.state !== 'docked' && t.state !== 'charging';

    return (
        <Shell
            icon="drone"
            tone="flame"
            title={drone.name}
            subtitle={drone.model}
            tag={
                <span
                    className={panel.tag}
                    data-tone={flying ? 'flame' : t.state === 'charging' ? undefined : 'ok'}
                >
                    {STATE_LABEL[t.state]}
                </span>
            }
        >
            <div className={styles.battery}>
                <div className={panel.row} style={{ justifyContent: 'space-between' }}>
                    <span className={panel.muted}>
                        <Icon name="battery" size={13} /> Battery{' '}
                        {t.state === 'charging' ? '· charging' : ''}
                    </span>
                    <strong className="mono">{t.batteryPct}%</strong>
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
                    <dt>Signal</dt>
                    <dd>{t.signalPct}%</dd>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Last reported position</dt>
                    <dd>
                        {t.lat.toFixed(5)}, {t.lon.toFixed(5)}
                    </dd>
                </div>
                <div>
                    <dt>Last seen</dt>
                    <dd>{Math.max(0, Math.round((now - t.lastSeenAt) / 1000))}s ago</dd>
                </div>
                <div>
                    <dt>Firmware</dt>
                    <dd>{drone.firmware}</dd>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Device ID</dt>
                    <dd>{drone.id}</dd>
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
                        <span>Paired {ago(drone.pairedAt)}</span>
                    </span>
                    <Icon name="chevronRight" size={12} />
                </button>
            ) : null}
            <div className={styles.actions}>
                <Button
                    size="sm"
                    icon="target"
                    onClick={() => viewer && void flyToPoint(viewer, [t.lat, t.lon], 3500, 1.2)}
                >
                    Locate
                </Button>
                {flying ? (
                    <Button size="sm" icon="stop" onClick={() => stopScan(zone.id)}>
                        Recall fleet
                    </Button>
                ) : null}
            </div>
        </Shell>
    );
}

function ReportView({ zone, id }: { zone: WatchZone; id: string }) {
    const setStatus = useZones((s) => s.setReportStatus);
    const select = useUi((s) => s.select);
    const report = zone.reports.find((r) => r.id === id);
    if (!report) return null;
    return (
        <Shell
            icon="camera"
            tone="flame"
            title="Civilian report"
            subtitle={`${report.from} · ${ago(report.receivedAt)}`}
            tag={
                <span
                    className={panel.tag}
                    data-tone={
                        report.status === 'new'
                            ? 'flame'
                            : report.status === 'verified'
                              ? 'ok'
                              : undefined
                    }
                >
                    {report.status === 'new'
                        ? 'Unverified'
                        : report.status === 'verified'
                          ? 'Verified'
                          : 'Dismissed'}
                </span>
            }
        >
            <div className={styles.photo} aria-label="Photo sent with the report">
                <span>Photo via SMS</span>
            </div>
            <blockquote className={styles.quote}>“{report.text}”</blockquote>
            <p className={panel.muted}>
                The civilian agent structured this text into a report at {report.lat.toFixed(4)},{' '}
                {report.lon.toFixed(4)}.
            </p>
            {report.status === 'new' ? (
                <div className={styles.actions}>
                    <Button
                        variant="primary"
                        icon="check"
                        onClick={() => {
                            setStatus(zone.id, report.id, 'verified');
                            notify(
                                'success',
                                'Report verified',
                                'It now shows on responder maps.',
                                zone,
                            );
                        }}
                    >
                        Verify
                    </Button>
                    <Button
                        icon="close"
                        onClick={() => {
                            setStatus(zone.id, report.id, 'dismissed');
                            select(null);
                        }}
                    >
                        Dismiss
                    </Button>
                </div>
            ) : null}
        </Shell>
    );
}

function CommunityView({ zone, id }: { zone: WatchZone; id: string }) {
    const impact = zone.civilianPlan?.impacts.find((c) => c.communityId === id);
    const route = zone.civilianPlan?.routes.find((r) => r.communityId === id);
    const safe = zone.safeZones.find((s) => s.id === route?.safeZoneId);
    const openBlast = useUi((s) => s.openBlast);
    if (!impact) return null;
    return (
        <Shell
            icon="home"
            title={impact.name}
            subtitle={`${impact.population.toLocaleString()} residents`}
            tag={
                <span
                    className={panel.tag}
                    data-tone={impact.urgency > 0.5 ? 'fire' : impact.urgency > 0 ? 'risk' : 'ok'}
                >
                    {impact.urgency > 0 ? `${Math.round(impact.urgency * 100)}% urgency` : 'Clear'}
                </span>
            }
        >
            <dl className={panel.kv}>
                <div>
                    <dt>Predicted fire arrival</dt>
                    <dd>{impact.arrivalMin === null ? 'Not in 6h' : minutes(impact.arrivalMin)}</dd>
                </div>
                <div>
                    <dt>Evacuation route</dt>
                    <dd>{route ? route.name : '—'}</dd>
                </div>
                {route ? (
                    <>
                        <div>
                            <dt>Distance</dt>
                            <dd>{route.distanceKm} km</dd>
                        </div>
                        <div>
                            <dt>Drive time</dt>
                            <dd>{route.etaMin} min</dd>
                        </div>
                    </>
                ) : null}
            </dl>
            {safe ? (
                <div className={panel.callout}>
                    <Icon name="shield" size={16} />
                    <span>
                        <strong>Safe zone: {safe.name}</strong>
                        The route bends away from every predicted fire front.
                    </span>
                </div>
            ) : null}
            {route ? (
                <Button
                    variant="primary"
                    icon="megaphone"
                    block
                    onClick={() =>
                        openBlast({
                            audience: 'civilians',
                            priority: 'critical',
                            title: `Evacuate ${impact.name}`,
                            body: `Ember alert: a wildfire is moving toward ${impact.name}. Evacuate now via ${route.name} to ${safe?.name ?? 'the nearest safe zone'}. Reply SAFE once you are out.`,
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

function DropView({ zone, id }: { zone: WatchZone; id: string }) {
    const site = zone.responderPlan?.dropSites.find((d) => d.id === id);
    const openBlast = useUi((s) => s.openBlast);
    if (!site) return null;
    return (
        <Shell icon="target" tone="sky" title={site.name} subtitle={site.purpose}>
            <dl className={panel.kv}>
                <div>
                    <dt>Radius</dt>
                    <dd>{site.radiusM} m</dd>
                </div>
                <div>
                    <dt>Crews</dt>
                    <dd>{site.crews}</dd>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                    <dt>Position</dt>
                    <dd>
                        {site.lat.toFixed(4)}, {site.lon.toFixed(4)}
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
                        title: `Stage at ${site.name}`,
                        body: `${site.purpose}. Stage ${site.crews} crew${site.crews === 1 ? '' : 's'} at ${site.lat.toFixed(4)}, ${site.lon.toFixed(4)} within ${site.radiusM} m.`,
                        area: 'zone',
                    })
                }
            >
                Send to responders
            </Button>
        </Shell>
    );
}

function SafeView({ zone, id }: { zone: WatchZone; id: string }) {
    const safe = zone.safeZones.find((s) => s.id === id);
    if (!safe) return null;
    const routes = zone.civilianPlan?.routes.filter((r) => r.safeZoneId === id) ?? [];
    return (
        <Shell icon="shield" tone="green" title={safe.name} subtitle="Safe zone">
            <p className={panel.lead}>
                {routes.length
                    ? `Receiving ${routes.map((r) => r.name).join(' and ')}.`
                    : 'No evacuation route ends here in the current plan.'}
            </p>
        </Shell>
    );
}

export function Inspector({ zone, picked }: { zone: WatchZone; picked: Picked }) {
    switch (picked.kind) {
        case 'server':
            return <ServerView zone={zone} id={picked.id} />;
        case 'drone':
            return <DroneView zone={zone} id={picked.id} />;
        case 'report':
            return <ReportView zone={zone} id={picked.id} />;
        case 'community':
            return <CommunityView zone={zone} id={picked.id} />;
        case 'drop':
            return <DropView zone={zone} id={picked.id} />;
        case 'safe':
            return <SafeView zone={zone} id={picked.id} />;
    }
}
