import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HttpError } from '../lib/client';
import { parsePairingCode } from '../lib/pairing';
import { useStore } from '../state/store';
import { Button } from '../ui/controls';
import { C, font } from '../ui/theme';

const FRAME = 240;

/**
 * Off until the api serves `RESPONDER_PAIR_PATH` and the dashboard puts a reachable api URL in its
 * code: any QR code then opens the demo zone so every screen can be tried.
 */
const PAIRING_LIVE = false;
const DEMO_LOADING_MS = 1200;

function describe(e: unknown): string {
    if (e instanceof HttpError && [401, 403, 410].includes(e.status)) return 'Code expired';
    return 'Connection failed';
}

function buzz(type: Haptics.NotificationFeedbackType) {
    void Haptics.notificationAsync(type).catch(() => undefined);
}

/** Unpaired, the app is the scanner: scan, download, map. */
export default function Home() {
    const { phase, connect, connectDemo } = useStore();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission] = useCameraPermissions();
    const [loading, setLoading] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const handled = useRef(false);

    useEffect(() => () => clearTimeout(hintTimer.current), []);

    useEffect(() => {
        if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    }, [permission, requestPermission]);

    if (phase === 'booting') return <View style={styles.blank} />;
    if (phase === 'ready') return <Redirect href="/zone" />;

    if (loading !== null) {
        return (
            <Animated.View entering={FadeIn} style={styles.loading}>
                <ActivityIndicator size="large" color={C.primary} />
                <Text style={font.title}>{loading}</Text>
                <Text style={font.small}>Downloading</Text>
            </Animated.View>
        );
    }

    const fail = (e: unknown) => {
        buzz(Haptics.NotificationFeedbackType.Error);
        setLoading(null);
        setError(describe(e));
    };

    // Without this, a code that is not ours looks like a scanner that does not work.
    const showHint = (text: string) => {
        clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setHint(null), 2000);
        if (hint !== text) setHint(text);
    };

    const startDemo = () => {
        handled.current = true;
        setError(null);
        setLoading('Demo site');
        // Long enough to see the loading screen; the demo bundle itself is instant.
        setTimeout(() => connectDemo().catch(fail), DEMO_LOADING_MS);
    };

    const onScan = ({ data }: BarcodeScanningResult) => {
        if (handled.current) return;
        if (!PAIRING_LIVE) {
            buzz(Haptics.NotificationFeedbackType.Success);
            startDemo();
            return;
        }
        const parsed = parsePairingCode(data);
        if (!parsed.ok) {
            if (parsed.reason === 'expired') setError('Code expired');
            else showHint('Not a site code');
            return;
        }
        handled.current = true;
        buzz(Haptics.NotificationFeedbackType.Success);
        setError(null);
        setLoading(parsed.code.zoneName);
        connect(parsed.code).catch(fail);
    };

    if (permission && !permission.granted) {
        return (
            <View style={[styles.permission, { paddingBottom: insets.bottom + 24 }]}>
                <View style={styles.permissionBody}>
                    <Text style={font.title}>Allow camera to scan</Text>
                </View>
                <Button
                    label={permission.canAskAgain ? 'Allow camera' : 'Open settings'}
                    onPress={() =>
                        permission.canAskAgain
                            ? void requestPermission()
                            : void Linking.openSettings()
                    }
                />
            </View>
        );
    }

    return (
        <View style={styles.root}>
            {permission && (
                <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    autofocus="on"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={error ? undefined : onScan}
                />
            )}
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <View style={styles.shade} />
                <View style={styles.middle}>
                    <View style={styles.shade} />
                    <View style={styles.frame}>
                        {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
                            <View key={c} style={[styles.corner, corner[c]]} />
                        ))}
                    </View>
                    <View style={styles.shade} />
                </View>
                <View style={[styles.shade, styles.caption]}>
                    <Text style={[font.heading, styles.light]}>
                        {hint ?? 'Scan the site QR code'}
                    </Text>
                </View>
            </View>

            {error && (
                <Animated.View
                    entering={FadeIn}
                    exiting={FadeOut}
                    style={[styles.error, { bottom: insets.bottom + 24 }]}
                >
                    <Text style={[font.heading, styles.errorText]}>{error}</Text>
                    <Button
                        label="Try again"
                        onPress={() => {
                            handled.current = false;
                            setError(null);
                        }}
                    />
                </Animated.View>
            )}

            {__DEV__ && !error && (
                <Pressable
                    accessibilityRole="button"
                    hitSlop={12}
                    onPress={startDemo}
                    style={[styles.demo, { bottom: insets.bottom + 16 }]}
                >
                    <Text style={[font.small, styles.dim]}>Demo</Text>
                </Pressable>
            )}
        </View>
    );
}

const corner = StyleSheet.create({
    tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 20 },
    tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 20 },
    bl: {
        bottom: 0,
        left: 0,
        borderBottomWidth: 4,
        borderLeftWidth: 4,
        borderBottomLeftRadius: 20,
    },
    br: {
        bottom: 0,
        right: 0,
        borderBottomWidth: 4,
        borderRightWidth: 4,
        borderBottomRightRadius: 20,
    },
});

const styles = StyleSheet.create({
    blank: { flex: 1, backgroundColor: C.bg },
    root: { flex: 1, backgroundColor: '#000' },
    shade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
    middle: { flexDirection: 'row', height: FRAME },
    frame: { width: FRAME, height: FRAME },
    corner: { position: 'absolute', width: 40, height: 40, borderColor: C.primary },
    caption: { alignItems: 'center', paddingTop: 28 },
    light: { color: '#FFFFFF' },
    dim: { color: 'rgba(255,255,255,0.6)' },
    error: {
        position: 'absolute',
        left: 16,
        right: 16,
        padding: 16,
        gap: 12,
        borderRadius: 18,
        backgroundColor: C.bg,
    },
    errorText: { textAlign: 'center', color: C.fire },
    demo: { position: 'absolute', alignSelf: 'center' },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        backgroundColor: C.bg,
    },
    permission: { flex: 1, paddingHorizontal: 24, backgroundColor: C.bg },
    permissionBody: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
