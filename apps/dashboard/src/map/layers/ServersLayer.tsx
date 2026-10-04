import {
    CallbackProperty,
    ClassificationType,
    Color,
    ColorMaterialProperty,
    ConstantPositionProperty,
    HeightReference,
    VerticalOrigin,
    type Entity,
} from 'cesium';
import { useEffect, useRef } from 'react';
import { circle } from '../../sim/geo';
import type { EdgeServer } from '../../sim/types';
import { prefersReducedMotion } from '../camera';
import { ALWAYS_ON_TOP, C, ICONS, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';
import { frameSeconds } from '../frameClock';

const now = frameSeconds;

/** 0..1, breathing: pending servers flash in and out until deployed. */
function breath(): number {
    return prefersReducedMotion() ? 0.7 : 0.5 + 0.5 * Math.sin(now() * 3.4);
}

const pendingFill = () =>
    new ColorMaterialProperty(
        new CallbackProperty(() => C.pink.withAlpha(0.05 + 0.16 * breath()), false),
    );
const pendingRing = () =>
    new ColorMaterialProperty(
        new CallbackProperty(() => C.pink.withAlpha(0.25 + 0.75 * breath()), false),
    );
const pendingTint = () =>
    new CallbackProperty(() => Color.WHITE.withAlpha(0.35 + 0.65 * breath()), false);

interface Props {
    servers: EdgeServer[];
    /** Hide the connectivity radii (icons stay). */
    radii?: boolean;
    selectedId?: string | null;
}

/** Edge servers and their pink connectivity radius. Pending ones flash; deployed ones hold still. */
export function ServersLayer({ servers, radii = true, selectedId = null }: Props) {
    const ds = useDataSource('servers');
    const deployedAt = useRef(new Map<string, number>());
    const known = useRef(new Map<string, EdgeServer>());
    const selected = useRef(selectedId);
    selected.current = selectedId;

    useEffect(() => {
        if (!ds) return;
        const ping = (id: string) => {
            const at = deployedAt.current.get(id);
            return at === undefined ? 0 : Math.min(1, (now() - at) / 1.1);
        };
        const keep = new Set<string>();
        for (const server of servers) {
            const id = server.id;
            const before = known.current.get(id);
            known.current.set(id, server);
            const pending = server.status === 'pending';
            const ids = [
                `server:${id}`,
                `server-fill:${id}`,
                `server-ring:${id}`,
                `server-ping:${id}`,
            ] as const;
            ids.forEach((x) => keep.add(x));
            const center = toCartesian([server.lat, server.lon]);
            const ring = circle([server.lat, server.lon], server.radiusM).map((p) =>
                toCartesian(p),
            );

            if (!before) {
                ds.entities.add({
                    id: ids[1],
                    position: center,
                    ellipse: {
                        semiMajorAxis: server.radiusM,
                        semiMinorAxis: server.radiusM,
                        classificationType: ClassificationType.BOTH,
                        material: pending ? pendingFill() : C.pink.withAlpha(0.11),
                    },
                });
                ds.entities.add({
                    id: ids[2],
                    polyline: {
                        positions: ring,
                        width: 2.2,
                        clampToGround: true,
                        classificationType: ClassificationType.BOTH,
                        material: pending ? pendingRing() : C.pink.withAlpha(0.75),
                    },
                });
                // A ring that sweeps out to the radius when the server connects.
                ds.entities.add({
                    id: ids[3],
                    position: center,
                    ellipse: {
                        semiMajorAxis: new CallbackProperty(
                            () => ping(id) * server.radiusM + 1,
                            false,
                        ),
                        semiMinorAxis: new CallbackProperty(
                            () => ping(id) * server.radiusM + 1,
                            false,
                        ),
                        classificationType: ClassificationType.BOTH,
                        material: new ColorMaterialProperty(
                            new CallbackProperty(() => {
                                const p = ping(id);
                                return p > 0 && p < 1
                                    ? C.pink.withAlpha(0.35 * (1 - p))
                                    : Color.TRANSPARENT;
                            }, false),
                        ),
                    },
                });
                ds.entities.add({
                    id: ids[0],
                    position: center,
                    billboard: {
                        image: pending ? ICONS.serverPending : ICONS.server,
                        width: 30,
                        height: 30,
                        verticalOrigin: VerticalOrigin.CENTER,
                        heightReference: HeightReference.CLAMP_TO_GROUND,
                        disableDepthTestDistance: ALWAYS_ON_TOP,
                        color: pending ? pendingTint() : Color.WHITE,
                        scale: new CallbackProperty(() => {
                            const p = ping(id);
                            const pop =
                                p > 0 && p < 0.35 ? 1 + 0.4 * Math.sin((p / 0.35) * Math.PI) : 1;
                            return (selected.current === id ? 1.2 : 1) * pop;
                        }, false),
                    },
                });
                continue;
            }

            const [icon, fill, ringEntity] = ids.slice(0, 3).map((x) => ds.entities.getById(x)) as [
                Entity,
                Entity,
                Entity,
            ];
            const ping_ = ds.entities.getById(ids[3]);
            if (before.lat !== server.lat || before.lon !== server.lon) {
                icon.position = new ConstantPositionProperty(center);
                fill.position = new ConstantPositionProperty(center);
                if (ping_) ping_.position = new ConstantPositionProperty(center);
                ringEntity.polyline!.positions = ring as never;
            }
            if (before.status !== server.status) {
                if (!pending) deployedAt.current.set(id, now());
                icon.billboard!.image = (pending ? ICONS.serverPending : ICONS.server) as never;
                icon.billboard!.color = (pending ? pendingTint() : Color.WHITE) as never;
                fill.ellipse!.material = pending
                    ? pendingFill()
                    : new ColorMaterialProperty(C.pink.withAlpha(0.11));
                ringEntity.polyline!.material = pending
                    ? pendingRing()
                    : new ColorMaterialProperty(C.pink.withAlpha(0.75));
            }
        }
        for (const entity of [...ds.entities.values]) {
            if (keep.has(entity.id)) continue;
            ds.entities.remove(entity);
            known.current.delete(entity.id.split(':')[1] ?? '');
        }
    }, [ds, servers]);

    useEffect(() => {
        if (!ds) return;
        for (const entity of ds.entities.values) {
            if (entity.id.startsWith('server-fill:') || entity.id.startsWith('server-ring:'))
                entity.show = radii;
        }
    }, [ds, radii, servers]);

    useEffect(
        () => () => {
            ds?.entities.removeAll();
            known.current.clear();
        },
        [ds],
    );

    return null;
}

export function serverIdOf(entity: Entity): string | null {
    return entity.id.startsWith('server:') ? entity.id.slice('server:'.length) : null;
}
