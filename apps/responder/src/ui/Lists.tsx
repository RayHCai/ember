import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AttackZone, ResponderMessage } from '@ember/contracts';
import { minutes, relativeTime } from '../lib/format';
import { tick } from './controls';
import { PinIcon } from './icons';
import { C, font } from './theme';

export function SiteList({
    zones,
    selectedId,
    onSelect,
}: {
    zones: AttackZone[];
    selectedId: string | null;
    onSelect: (z: AttackZone) => void;
}) {
    if (zones.length === 0) return <Text style={[font.body, styles.empty]}>No sites yet</Text>;
    return (
        <View>
            {zones.map((z) => {
                const on = z.id === selectedId;
                return (
                    <Pressable
                        key={z.id}
                        accessibilityRole="button"
                        onPress={() => {
                            tick();
                            onSelect(z);
                        }}
                        style={({ pressed }) => [
                            styles.row,
                            (on || pressed) && { backgroundColor: C.tint },
                        ]}
                    >
                        <View style={[styles.rank, on && { backgroundColor: C.primary }]}>
                            <Text style={styles.rankText}>{z.rank}</Text>
                        </View>
                        <View style={styles.main}>
                            <Text style={font.heading}>Site {z.rank}</Text>
                            <Text style={font.small}>
                                {z.tactic === 'direct' ? 'Direct' : 'Cut line'}
                                {z.accessMin != null ? ` · ${minutes(z.accessMin)} drive` : ''}
                            </Text>
                        </View>
                        <View style={styles.eta}>
                            <Text style={[font.num, z.fireArrivalMin < 60 && { color: C.fire }]}>
                                {minutes(z.fireArrivalMin)}
                            </Text>
                            <Text style={font.small}>to fire</Text>
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}

export function MessageList({
    messages,
    lastReadAt,
    onOpen,
}: {
    messages: ResponderMessage[];
    lastReadAt: string | null;
    onOpen: (m: ResponderMessage) => void;
}) {
    if (messages.length === 0) return <Text style={[font.body, styles.empty]}>No messages</Text>;
    const readT = lastReadAt ? Date.parse(lastReadAt) : 0;
    return (
        <View>
            {messages.map((m) => {
                const unread = Date.parse(m.sentAt) > readT;
                const urgent = m.priority !== 'routine';
                return (
                    <Pressable
                        key={m.id}
                        accessibilityRole="button"
                        onPress={() => {
                            tick();
                            onOpen(m);
                        }}
                        style={({ pressed }) => [
                            styles.msg,
                            pressed && { backgroundColor: C.tint },
                        ]}
                    >
                        <View style={styles.msgTop}>
                            {unread && <View style={styles.dot} />}
                            <Text
                                style={[font.heading, styles.main, urgent && { color: C.fire }]}
                                numberOfLines={1}
                            >
                                {m.title}
                            </Text>
                            {m.location && <PinIcon color={C.faint} />}
                            <Text style={font.small}>{relativeTime(m.sentAt)}</Text>
                        </View>
                        <Text style={font.body}>{m.body}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    empty: { padding: 24, textAlign: 'center', color: C.faint },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    rank: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.site,
    },
    rankText: { color: C.onPrimary, fontSize: 14, fontWeight: '700' },
    main: { flex: 1, gap: 2 },
    eta: { alignItems: 'flex-end' },
    msg: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        gap: 4,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: C.border,
    },
    msgTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary },
});
