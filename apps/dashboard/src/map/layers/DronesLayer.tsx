import {
    CallbackPositionProperty,
    CallbackProperty,
    Cartesian2,
    Cartesian3,
    Color,
    HeightReference,
    Math as CesiumMath,
} from 'cesium';
import { useEffect, useRef } from 'react';
import { getTelemetry } from '../../sim/live';
import type { Drone, DroneTelemetry } from '../../sim/types';
import { ALWAYS_ON_TOP, C, ICONS } from '../style';
import { useDataSource } from '../useDataSource';

const TRAIL = 7;
const TRAIL_SAMPLE_MS = 110;

const airborne = (t: DroneTelemetry | undefined) =>
    t !== undefined && t.state !== 'docked' && t.state !== 'charging';

interface Props {
    drones: Drone[];
    selectedId?: string | null;
}

/** Drones at their last reported position. Docked ones cluster around their edge server. */
export function DronesLayer({ drones, selectedId = null }: Props) {
    const ds = useDataSource('drones');
    const selected = useRef(selectedId);
    selected.current = selectedId;

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        drones.forEach((drone) => {
            const sameServer = drones.filter((d) => d.serverId === drone.serverId);
            const slot = sameServer.findIndex((d) => d.id === drone.id);
            const angle = (slot / Math.max(1, sameServer.length)) * Math.PI * 2 + Math.PI / 4;
            const dockOffset = new Cartesian2(Math.cos(angle) * 22, -Math.sin(angle) * 22);
            const trail: Cartesian3[] = [];
            let lastSample = 0;

            const position = () => {
                const t = getTelemetry(drone.id);
                return t
                    ? Cartesian3.fromDegrees(t.lon, t.lat, airborne(t) ? t.altM : 0)
                    : undefined;
            };

            ds.entities.add({
                id: `drone:${drone.id}`,
                position: new CallbackPositionProperty(() => {
                    const p = position();
                    const t = getTelemetry(drone.id);
                    const nowMs = performance.now();
                    if (p && airborne(t) && nowMs - lastSample > TRAIL_SAMPLE_MS) {
                        trail.unshift(p);
                        trail.length = Math.min(trail.length, TRAIL);
                        lastSample = nowMs;
                    } else if (!airborne(t)) {
                        trail.length = 0;
                    }
                    return p;
                }, false),
                billboard: {
                    image: new CallbackProperty(
                        () => (airborne(getTelemetry(drone.id)) ? ICONS.droneActive : ICONS.drone),
                        false,
                    ),
                    width: 26,
                    height: 26,
                    rotation: new CallbackProperty(
                        () => -CesiumMath.toRadians(getTelemetry(drone.id)?.headingDeg ?? 0),
                        false,
                    ),
                    alignedAxis: Cartesian3.UNIT_Z,
                    pixelOffset: new CallbackProperty(
                        () => (airborne(getTelemetry(drone.id)) ? Cartesian2.ZERO : dockOffset),
                        false,
                    ),
                    scale: new CallbackProperty(() => {
                        const base = airborne(getTelemetry(drone.id)) ? 1 : 0.74;
                        return selected.current === drone.id ? base * 1.35 : base;
                    }, false),
                    heightReference: HeightReference.RELATIVE_TO_GROUND,
                    disableDepthTestDistance: ALWAYS_ON_TOP,
                },
            });
            for (let k = 1; k < TRAIL; k++) {
                ds.entities.add({
                    id: `drone-trail:${drone.id}:${k}`,
                    position: new CallbackPositionProperty(
                        () => trail[k] ?? trail[0] ?? position(),
                        false,
                    ),
                    point: {
                        pixelSize: 6 - k * 0.6,
                        color: new CallbackProperty(
                            () =>
                                trail[k]
                                    ? C.flame.withAlpha(0.55 * (1 - k / TRAIL))
                                    : Color.TRANSPARENT,
                            false,
                        ),
                        heightReference: HeightReference.RELATIVE_TO_GROUND,
                        disableDepthTestDistance: ALWAYS_ON_TOP,
                    },
                });
            }
        });
        return () => ds.entities.removeAll();
    }, [ds, drones]);

    return null;
}
