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
import { getTelemetry, isAirborne, livePosition } from '../../live/telemetry';
import type { DroneView, ServerView } from '../../model/types';
import { ALWAYS_ON_TOP, C, ICONS } from '../style';
import { useDataSource } from '../useDataSource';

const TRAIL = 7;
const TRAIL_SAMPLE_MS = 110;

interface Props {
    drones: DroneView[];
    servers: ServerView[];
    selectedId?: string | null;
}

/**
 * Drones where drone-info last saw them, moving live while they fly. A drone drone-info has not
 * heard from waits beside its edge server.
 */
export function DronesLayer({ drones, servers, selectedId = null }: Props) {
    const ds = useDataSource('drones');
    const selected = useRef(selectedId);
    selected.current = selectedId;
    const latest = useRef({ drones, servers });
    latest.current = { drones, servers };
    // Polls hand over fresh arrays; rebuild only when what is drawn changes, so trails survive.
    const signature = [
        drones.map((d) => `${d.id}@${d.serverId}`).join(','),
        servers.map((s) => `${s.id}@${s.lat},${s.lon}`).join(','),
    ].join('|');

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        const current = latest.current;
        current.drones.forEach((drone) => {
            const server = current.servers.find((s) => s.id === drone.serverId);
            const sameServer = current.drones.filter((d) => d.serverId === drone.serverId);
            const slot = sameServer.findIndex((d) => d.id === drone.id);
            const angle = (slot / Math.max(1, sameServer.length)) * Math.PI * 2 + Math.PI / 4;
            const dockOffset = new Cartesian2(Math.cos(angle) * 22, -Math.sin(angle) * 22);
            const dock = server ? Cartesian3.fromDegrees(server.lon, server.lat, 0) : undefined;
            const trail: Cartesian3[] = [];
            let lastSample = 0;

            const position = () => {
                const p = livePosition(drone.id);
                if (!p) return dock;
                return Cartesian3.fromDegrees(
                    p.lon,
                    p.lat,
                    isAirborne(getTelemetry(drone.id)) ? p.altM : 0,
                );
            };

            ds.entities.add({
                id: `drone:${drone.id}`,
                position: new CallbackPositionProperty(() => {
                    const p = position();
                    const flying = isAirborne(getTelemetry(drone.id));
                    const nowMs = performance.now();
                    if (p && flying && nowMs - lastSample > TRAIL_SAMPLE_MS) {
                        trail.unshift(p);
                        trail.length = Math.min(trail.length, TRAIL);
                        lastSample = nowMs;
                    } else if (!flying) {
                        trail.length = 0;
                    }
                    return p;
                }, false),
                billboard: {
                    image: new CallbackProperty(
                        () =>
                            isAirborne(getTelemetry(drone.id)) ? ICONS.droneActive : ICONS.drone,
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
                        () => (getTelemetry(drone.id) ? Cartesian2.ZERO : dockOffset),
                        false,
                    ),
                    color: new CallbackProperty(
                        () => (getTelemetry(drone.id) ? Color.WHITE : Color.WHITE.withAlpha(0.55)),
                        false,
                    ),
                    scale: new CallbackProperty(() => {
                        const base = isAirborne(getTelemetry(drone.id)) ? 1 : 0.74;
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
    }, [ds, signature]);

    return null;
}
