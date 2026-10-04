import { CallbackProperty, ClassificationType, Color, ColorMaterialProperty } from 'cesium';
import { useEffect } from 'react';
import type { EdgeServer } from '../../sim/types';
import { C, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';
import { frameMilliseconds } from '../frameClock';

/** Radar rings rolling out from each edge server while it listens for new drones. */
export function PairingLayer({ servers, active }: { servers: EdgeServer[]; active: boolean }) {
    const ds = useDataSource('pairing');

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        if (!active) return;
        const start = frameMilliseconds();
        for (const server of servers) {
            if (server.status !== 'deployed') continue;
            for (let k = 0; k < 2; k++) {
                const phase = () =>
                    ((((frameMilliseconds() - start) / 1600 + k * 0.5) % 1) + 1) % 1;
                ds.entities.add({
                    id: `pair:${server.id}:${k}`,
                    position: toCartesian([server.lat, server.lon]),
                    ellipse: {
                        semiMajorAxis: new CallbackProperty(
                            () => 40 + phase() * server.radiusM * 0.55,
                            false,
                        ),
                        semiMinorAxis: new CallbackProperty(
                            () => 40 + phase() * server.radiusM * 0.55,
                            false,
                        ),
                        classificationType: ClassificationType.BOTH,
                        material: new ColorMaterialProperty(
                            new CallbackProperty(() => {
                                const p = phase();
                                return p < 0.98
                                    ? C.flame.withAlpha(0.32 * (1 - p))
                                    : Color.TRANSPARENT;
                            }, false),
                        ),
                    },
                });
            }
        }
        return () => ds.entities.removeAll();
    }, [ds, servers, active]);

    return null;
}
