import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { C, font } from './theme';

export function tick() {
    void Haptics.selectionAsync().catch(() => undefined);
}

export const shadow = {
    shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 12,
    elevation: 4,
} as const;

export function Button({
    label,
    onPress,
    style,
}: {
    label: string;
    onPress: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    return (
        <Pressable
            accessibilityRole="button"
            onPress={() => {
                tick();
                onPress();
            }}
            style={({ pressed }) => [
                styles.button,
                { backgroundColor: pressed ? C.primaryDark : C.primary },
                style,
            ]}
        >
            <Text style={[font.heading, { color: C.onPrimary }]}>{label}</Text>
        </Pressable>
    );
}

export function IconButton({
    label,
    onPress,
    children,
    style,
}: {
    label: string;
    onPress: () => void;
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={8}
            onPress={() => {
                tick();
                onPress();
            }}
            style={({ pressed }) => [styles.icon, { opacity: pressed ? 0.7 : 1 }, style]}
        >
            {children}
        </Pressable>
    );
}

export function Tabs<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string; badge?: number }[];
    onChange: (v: T) => void;
}) {
    return (
        <View style={styles.tabs}>
            {options.map((o) => {
                const on = o.value === value;
                return (
                    <Pressable
                        key={o.value}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: on }}
                        onPress={() => {
                            if (!on) tick();
                            onChange(o.value);
                        }}
                        style={styles.tab}
                    >
                        <Text style={[font.label, { color: on ? C.text : C.faint }]}>
                            {o.label}
                        </Text>
                        {!!o.badge && (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>{o.badge > 9 ? '9+' : o.badge}</Text>
                            </View>
                        )}
                        <View style={[styles.underline, on && { backgroundColor: C.primary }]} />
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    button: {
        height: 52,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    icon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.bg,
        ...shadow,
    },
    tabs: {
        flexDirection: 'row',
        gap: 24,
        paddingHorizontal: 20,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: C.border,
    },
    tab: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40 },
    underline: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: -StyleSheet.hairlineWidth,
        height: 2,
        borderRadius: 1,
    },
    badge: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.primary,
    },
    badgeText: { color: C.onPrimary, fontSize: 11, fontWeight: '700' },
});
