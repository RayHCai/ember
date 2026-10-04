import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import type { AttackZone, DroneSummary, LatLng } from '@ember/contracts';
import { fitCamera, screenToWorld, type Camera, type Size } from '../lib/geo';
import { minutes } from '../lib/format';
import { C } from '../ui/theme';
import { hitAttack, type ZoneGeometry } from './geometry';

export type FocusRequest = { point: LatLng; key: number } | { fit: true; key: number };

type Props = {
    geometry: ZoneGeometry;
    selectedId: string | null;
    drones: DroneSummary[];
    focus: FocusRequest | null;
    /** Screen space covered by overlays, so fitting centres the zone in what stays visible. */
    insets: { top: number; bottom: number };
    onSelect: (zone: AttackZone | null) => void;
};

const MAX_ZOOM = 14;
const MIN_ZOOM = 0.6;

export function ZoneMap({ geometry, selectedId, drones, focus, insets, onSelect }: Props) {
    const [size, setSize] = useState<Size | null>(null);
    const [cam, setCam] = useState<Camera | null>(null);

    const fit = useMemo(() => {
        if (!size) return null;
        const visible = { width: size.width, height: size.height - insets.top - insets.bottom };
        const c = fitCamera(geometry.bounds, visible, 28);
        return { ...c, cy: c.cy - (insets.top - insets.bottom) / 2 / c.scale };
    }, [geometry, size, insets.top, insets.bottom]);

    useEffect(() => {
        if (fit && !cam) setCam(fit);
    }, [fit, cam]);

    useEffect(() => {
        if (!focus || !fit) return;
        if ('fit' in focus) {
            setCam(fit);
            return;
        }
        const p = geometry.proj.toXY(focus.point);
        setCam((c) => {
            const scale = Math.max(c?.scale ?? fit.scale, fit.scale * 2.4);
            return { cx: p.x, cy: p.y + (insets.bottom - insets.top) / 2 / scale, scale };
        });
        // Only a new request should move the camera, not a resize.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focus?.key]);

    // Live gesture transform, folded into `cam` when the gesture ends.
    const tx = useSharedValue(0);
    const ty = useSharedValue(0);
    const s = useSharedValue(1);
    const start = useSharedValue({ tx: 0, ty: 0, s: 1, fx: 0, fy: 0 });
    const active = useSharedValue(0);

    const commit = useCallback(
        (dx: number, dy: number, ds: number) => {
            setCam((c) => {
                if (!c || !fit || (dx === 0 && dy === 0 && ds === 1)) return c;
                const scale = Math.min(
                    Math.max(c.scale * ds, fit.scale * MIN_ZOOM),
                    fit.scale * MAX_ZOOM,
                );
                return { cx: c.cx - dx / ds / c.scale, cy: c.cy - dy / ds / c.scale, scale };
            });
        },
        [fit],
    );

    useLayoutEffect(() => {
        tx.value = 0;
        ty.value = 0;
        s.value = 1;
    }, [cam, tx, ty, s]);

    const gesture = useMemo(() => {
        const finish = () => {
            'worklet';
            active.value -= 1;
            if (active.value <= 0) {
                active.value = 0;
                scheduleOnRN(commit, tx.value, ty.value, s.value);
            }
        };
        const pan = Gesture.Pan()
            .maxPointers(1)
            .onStart(() => {
                active.value += 1;
                start.value = { ...start.value, tx: tx.value, ty: ty.value };
            })
            .onUpdate((e) => {
                tx.value = start.value.tx + e.translationX;
                ty.value = start.value.ty + e.translationY;
            })
            .onEnd(finish);
        const pinch = Gesture.Pinch()
            .onStart((e) => {
                active.value += 1;
                start.value = {
                    tx: tx.value,
                    ty: ty.value,
                    s: s.value,
                    fx: e.focalX,
                    fy: e.focalY,
                };
            })
            .onUpdate((e) => {
                if (!size) return;
                const st = start.value;
                const next = st.s * e.scale;
                // Keep the content under the fingers' midpoint pinned while it moves.
                const ox = st.fx - size.width / 2 - st.tx;
                const oy = st.fy - size.height / 2 - st.ty;
                s.value = next;
                tx.value = e.focalX - size.width / 2 - (next / st.s) * ox;
                ty.value = e.focalY - size.height / 2 - (next / st.s) * oy;
            })
            .onEnd(finish);
        const tap = Gesture.Tap()
            .maxDuration(250)
            .onEnd((e, ok) => {
                if (ok) scheduleOnRN(handleTap, e.x, e.y);
            });
        const doubleTap = Gesture.Tap()
            .numberOfTaps(2)
            .onEnd((e, ok) => {
                if (ok) scheduleOnRN(zoomAt, e.x, e.y);
            });
        return Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, tap));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [size, commit, cam, geometry]);

    function handleTap(x: number, y: number) {
        if (!cam || !size) return;
        const w = screenToWorld(cam, size, { x, y });
        onSelect(hitAttack(geometry, w, 14 / cam.scale));
    }

    function zoomAt(x: number, y: number) {
        if (!cam || !size || !fit) return;
        const w = screenToWorld(cam, size, { x, y });
        const scale = Math.min(cam.scale * 2, fit.scale * MAX_ZOOM);
        setCam({ cx: (cam.cx + w.x) / 2, cy: (cam.cy + w.y) / 2, scale });
    }

    const animated = useAnimatedStyle(() => ({
        transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: s.value }],
    }));

    const onLayout = (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) =>
            prev && prev.width === width && prev.height === height ? prev : { width, height },
        );
    };

    return (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: C.map.sea }]} onLayout={onLayout}>
            {size && cam && (
                <GestureDetector gesture={gesture}>
                    <Animated.View style={[StyleSheet.absoluteFill, animated]}>
                        <Svg
                            width={size.width}
                            height={size.height}
                            viewBox={`${cam.cx - size.width / 2 / cam.scale} ${cam.cy - size.height / 2 / cam.scale} ${size.width / cam.scale} ${size.height / cam.scale}`}
                        >
                            <BaseLayer g={geometry} k={1 / cam.scale} />
                            <RiskLayer g={geometry} k={1 / cam.scale} />
                            <SpreadLayer g={geometry} k={1 / cam.scale} />
                            <AttackLayer
                                g={geometry}

                                k={1 / cam.scale}
                                selectedId={selectedId}
                            />
                            {drones.length > 0 && (
                                <DroneLayer
                                    g={geometry}

                                    k={1 / cam.scale}
                                    drones={drones}
                                />
                            )}
                        </Svg>
                    </Animated.View>
                </GestureDetector>
            )}
        </View>
    );
}

type LayerProps = { g: ZoneGeometry; k: number };

/** `k` is metres per screen pixel: every size below is in pixels times `k` so it holds at any zoom. */
const BaseLayer = memo(function BaseLayer({ g, k }: LayerProps) {
    return (
        <G>
            <Path d={g.boundary} fill={C.map.land} />
            {g.fuel.map((f) => (
                <Rect
                    key={`${f.x},${f.y}`}
                    x={f.x}
                    y={f.y}
                    width={f.w + 0.5}
                    height={f.h + 0.5}
                    fill={C.map.fuel[f.fuel]}
                />
            ))}
            {g.roads.map((r) => (
                <Path
                    key={`${r.id}-c`}
                    d={r.d}
                    stroke={C.map.roadCasing}
                    strokeWidth={(r.kind === 'track' ? 3 : 5.5) * k}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ))}
            {g.roads.map((r) => (
                <Path
                    key={r.id}
                    d={r.d}
                    stroke={C.map.road}
                    strokeWidth={(r.kind === 'track' ? 1.5 : 3.5) * k}
                    strokeDasharray={r.kind === 'track' ? `${4 * k} ${3 * k}` : undefined}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ))}
            <Path
                d={g.boundary}
                fill="none"
                stroke={C.map.boundary}
                strokeOpacity={0.55}
                strokeWidth={1.5 * k}
                strokeDasharray={`${6 * k} ${4 * k}`}
            />
            {g.places.map((p) => (
                <SvgText
                    key={p.id}
                    x={p.p.x}
                    y={p.p.y}
                    fontSize={11 * k}
                    fontWeight="600"
                    fill={C.map.label}
                    fillOpacity={0.75}
                    textAnchor="middle"
                >
                    {p.name}
                </SvgText>
            ))}
            {g.safeZones.map((z) => (
                <G key={z.id}>
                    <Circle
                        cx={z.p.x}
                        cy={z.p.y}
                        r={7 * k}
                        fill={C.safe}
                        stroke={C.bg}
                        strokeWidth={2 * k}
                    />
                    <Path
                        d={`M${z.p.x - 3 * k} ${z.p.y}l${2.2 * k} ${2.2 * k}l${4 * k} ${-4.4 * k}`}
                        stroke="#fff"
                        strokeWidth={1.6 * k}
                        fill="none"
                    />
                </G>
            ))}
            {g.stations.map((st) => (
                <Rect
                    key={st.id}
                    x={st.p.x - 6 * k}
                    y={st.p.y - 6 * k}
                    width={12 * k}
                    height={12 * k}
                    rx={3 * k}
                    fill={C.text}
                    stroke={C.bg}
                    strokeWidth={2 * k}
                />
            ))}
        </G>
    );
});

const RiskLayer = memo(function RiskLayer({ g, k }: LayerProps) {
    return (
        <G>
            {g.risk.map((z) => (
                <Path
                    key={z.id}
                    d={z.d}
                    fill={z.risk === 'on_fire' ? C.fire : C.risk}
                    fillOpacity={z.risk === 'on_fire' ? 0.55 : 0.28}
                    stroke={z.risk === 'on_fire' ? C.fire : C.risk}
                    strokeWidth={1.5 * k}
                />
            ))}
            {g.detections.map((d) => (
                <Circle
                    key={d.id}
                    cx={d.p.x}
                    cy={d.p.y}
                    r={4 * k}
                    fill={d.risk === 'on_fire' ? C.fire : C.risk}
                    stroke={C.bg}
                    strokeWidth={1.5 * k}
                />
            ))}
        </G>
    );
});

const SpreadLayer = memo(function SpreadLayer({ g, k }: LayerProps) {
    const n = g.isochrones.length;
    return (
        <G>
            {g.isochrones.map((iso, i) => (
                <Path
                    key={iso.atMin}
                    d={iso.d}
                    fill={C.spread}
                    fillOpacity={0.05 + (0.1 * i) / Math.max(n - 1, 1)}
                    stroke={C.spread}
                    strokeOpacity={0.7}
                    strokeWidth={1.2 * k}
                    strokeDasharray={`${5 * k} ${4 * k}`}
                    fillRule="evenodd"
                />
            ))}
            {g.track && (
                <Path
                    d={g.track}
                    stroke={C.fire}
                    strokeWidth={2.5 * k}
                    fill="none"
                    strokeLinecap="round"
                />
            )}
            {g.head && (
                <Path
                    d={`M0 ${-9 * k} L${6 * k} ${6 * k} L0 ${2 * k} L${-6 * k} ${6 * k}Z`}
                    fill={C.fire}
                    stroke={C.bg}
                    strokeWidth={1.5 * k}
                    transform={`translate(${g.head.p.x} ${g.head.p.y}) rotate(${g.head.deg})`}
                />
            )}
            {g.isochrones.map((iso) => (
                <G key={`l${iso.atMin}`}>
                    <Rect
                        x={iso.label.x - 17 * k}
                        y={iso.label.y - 8 * k}
                        width={34 * k}
                        height={16 * k}
                        rx={8 * k}
                        fill={C.bg}
                        fillOpacity={0.92}
                    />
                    <SvgText
                        x={iso.label.x}
                        y={iso.label.y + 3.8 * k}
                        fontSize={10.5 * k}
                        fontWeight="700"
                        fill={C.spread}
                        textAnchor="middle"
                    >
                        {`+${minutes(iso.atMin)}`}
                    </SvgText>
                </G>
            ))}
        </G>
    );
});

const AttackLayer = memo(function AttackLayer({
    g,
    k,
    selectedId,
}: LayerProps & { selectedId: string | null }) {
    return (
        <G>
            {g.attack.map(({ zone, p, r }) => {
                const on = zone.id === selectedId;
                const dim = selectedId !== null && !on;
                return (
                    <G key={zone.id} opacity={dim ? 0.45 : 1}>
                        <Circle
                            cx={p.x}
                            cy={p.y}
                            r={r}
                            fill={on ? C.primary : C.site}
                            fillOpacity={on ? 0.14 : 0.06}
                            stroke={on ? C.primary : C.site}
                            strokeWidth={(on ? 3 : 2) * k}
                            strokeDasharray={on ? undefined : `${6 * k} ${4 * k}`}
                        />
                        <Circle
                            cx={p.x}
                            cy={p.y}
                            r={(on ? 14 : 11) * k}
                            fill={on ? C.primary : C.site}
                            stroke={C.bg}
                            strokeWidth={2 * k}
                        />
                        <SvgText
                            x={p.x}
                            y={p.y + (on ? 4.6 : 4) * k}
                            fontSize={(on ? 13 : 11.5) * k}
                            fontWeight="800"
                            fill="#fff"
                            textAnchor="middle"
                        >
                            {String(zone.rank)}
                        </SvgText>
                    </G>
                );
            })}
        </G>
    );
});

const DroneLayer = memo(function DroneLayer({
    g,
    k,
    drones,
}: LayerProps & { drones: DroneSummary[] }) {
    return (
        <G>
            {drones.map((d) => {
                const p = g.proj.toXY(d.pose);
                return (
                    <G
                        key={d.droneId}
                        transform={`translate(${p.x} ${p.y}) rotate(${d.pose.headingDeg})`}
                    >
                        <Circle r={9 * k} fill={C.text} fillOpacity={0.12} />
                        <Path
                            d={`M0 ${-6 * k} L${4.5 * k} ${5 * k} L0 ${2.5 * k} L${-4.5 * k} ${5 * k}Z`}
                            fill={C.text}
                            stroke={C.bg}
                            strokeWidth={1.2 * k}
                        />
                    </G>
                );
            })}
        </G>
    );
});
