import { Redirect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttackZone, LatLng, ResponderMessage } from '@ember/contracts';
import { unreadCount } from '../lib/feed';
import { relativeTime } from '../lib/format';
import { buildGeometry } from '../map/geometry';
import { ZoneMap, type FocusRequest } from '../map/ZoneMap';
import { useStore } from '../state/store';
import { useFleet } from '../state/useFleet';
import { Banner } from '../ui/Banner';
import { IconButton, shadow, Tabs } from '../ui/controls';
import { MoreIcon, RecenterIcon } from '../ui/icons';
import { MessageList, SiteList } from '../ui/Lists';
import { Sheet } from '../ui/Sheet';
import { C, font } from '../ui/theme';

const PEEK = 136;
const TOP_BAR = 96;

function confirmLeave(onLeave: () => void) {
    Alert.alert('Leave site?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: onLeave },
    ]);
}

export default function Zone() {
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const store = useStore();
    const { session, bundle, feed, online, banner, markRead, dismissBanner, disconnect } = store;

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [focus, setFocus] = useState<FocusRequest | null>(null);
    const [tab, setTab] = useState<'sites' | 'messages'>('sites');
    const [expanded, setExpanded] = useState(false);
    const focusKey = useRef(0);

    const geometry = useMemo(() => (bundle ? buildGeometry(bundle) : null), [bundle]);
    const drones = useFleet(session?.droneInfoUrl ?? null, online);
    const unread = unreadCount(feed.messages, feed.lastReadAt);

    useEffect(() => {
        if (tab === 'messages' && expanded && unread > 0) markRead();
    }, [tab, expanded, unread, markRead]);

    const focusOn = useCallback((req: { point: LatLng } | { fit: true }) => {
        focusKey.current += 1;
        setFocus({ ...req, key: focusKey.current });
    }, []);

    const selectSite = useCallback(
        (z: AttackZone | null) => {
            setSelectedId(z?.id ?? null);
            if (z) {
                setExpanded(false);
                focusOn({ point: z.center });
            }
        },
        [focusOn],
    );

    const openMessage = useCallback(
        (m: ResponderMessage) => {
            dismissBanner();
            if (m.location) {
                setExpanded(false);
                focusOn({ point: m.location });
            } else {
                setTab('messages');
                setExpanded(true);
            }
        },
        [focusOn, dismissBanner],
    );

    if (!session || !bundle || !geometry) return <Redirect href="/" />;

    const peek = PEEK + insets.bottom;
    const offline = !online && session.apiUrl !== 'demo:';
    const stale = offline || !!store.syncError;

    return (
        <View style={styles.root}>
            <ZoneMap
                geometry={geometry}
                selectedId={selectedId}
                drones={drones}
                focus={focus}
                insets={{ top: insets.top + TOP_BAR, bottom: peek }}
                onSelect={selectSite}
            />

            <View style={[styles.top, { top: insets.top + 8 }]} pointerEvents="box-none">
                <View style={styles.title}>
                    <View style={[styles.dot, { backgroundColor: stale ? C.risk : C.safe }]} />
                    <Text style={[font.heading, styles.name]} numberOfLines={1}>
                        {bundle.name}
                    </Text>
                    {stale && (
                        <Text style={font.small}>
                            {offline ? 'Offline' : 'No sync'} ·{' '}
                            {relativeTime(feed.lastSyncedAt ?? bundle.generatedAt)}
                        </Text>
                    )}
                </View>
                <IconButton label="Leave site" onPress={() => confirmLeave(disconnect)}>
                    <MoreIcon color={C.text} />
                </IconButton>
            </View>

            <View style={[styles.legend, { top: insets.top + 64 }]} pointerEvents="none">
                <Key color={C.fire} label="Fire" />
                <Key color={C.spread} label="Spread" dashed />
                <Key color={C.site} label="Site" ring />
            </View>

            <IconButton
                label="Fit site"
                onPress={() => {
                    setSelectedId(null);
                    focusOn({ fit: true });
                }}
                style={[styles.recenter, { bottom: peek + 12 }]}
            >
                <RecenterIcon color={C.text} />
            </IconButton>

            <Sheet
                height={Math.round(height * 0.7)}
                peek={peek}
                expanded={expanded}
                onExpandedChange={setExpanded}
                header={
                    <Tabs
                        value={tab}
                        onChange={(v) => {
                            setTab(v);
                            setExpanded(true);
                        }}
                        options={[
                            { value: 'sites', label: 'Sites' },
                            { value: 'messages', label: 'Messages', badge: unread },
                        ]}
                    />
                }
            >
                <ScrollView
                    contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
                    showsVerticalScrollIndicator={false}
                    scrollEnabled={expanded}
                >
                    {tab === 'sites' ? (
                        <SiteList
                            zones={bundle.plan?.attackZones ?? []}
                            selectedId={selectedId}
                            onSelect={selectSite}
                        />
                    ) : (
                        <MessageList
                            messages={feed.messages}
                            lastReadAt={feed.lastReadAt}
                            onOpen={openMessage}
                        />
                    )}
                </ScrollView>
            </Sheet>

            {banner && (
                <Banner
                    message={banner}
                    top={insets.top + 8}
                    onPress={() => openMessage(banner)}
                    onDismiss={dismissBanner}
                />
            )}
        </View>
    );
}

function Key({
    color,
    label,
    dashed,
    ring,
}: {
    color: string;
    label: string;
    dashed?: boolean;
    ring?: boolean;
}) {
    return (
        <View style={styles.key}>
            <View
                style={[
                    styles.swatch,
                    ring
                        ? { borderWidth: 2, borderColor: color }
                        : dashed
                          ? { borderWidth: 2, borderColor: color, borderStyle: 'dashed' }
                          : { backgroundColor: color },
                ]}
            />
            <Text style={font.small}>{label}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    top: {
        position: 'absolute',
        left: 12,
        right: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    title: {
        flex: 1,
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        borderRadius: 22,
        backgroundColor: C.bg,
        ...shadow,
    },
    name: { flexShrink: 1 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    legend: {
        position: 'absolute',
        left: 12,
        flexDirection: 'row',
        gap: 14,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.92)',
    },
    key: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    swatch: { width: 10, height: 10, borderRadius: 5 },
    recenter: { position: 'absolute', right: 12 },
});
