import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import type { ResponderMessage } from '@ember/contracts';
import { shadow } from './controls';
import { C, font } from './theme';

const SHOW_MS = 6_000;

/** A message that arrived while the app is open. */
export function Banner({
    message,
    top,
    onPress,
    onDismiss,
}: {
    message: ResponderMessage;
    top: number;
    onPress: () => void;
    onDismiss: () => void;
}) {
    useEffect(() => {
        void Haptics.notificationAsync(
            message.priority === 'routine'
                ? Haptics.NotificationFeedbackType.Success
                : Haptics.NotificationFeedbackType.Warning,
        ).catch(() => undefined);
        const t = setTimeout(onDismiss, SHOW_MS);
        return () => clearTimeout(t);
    }, [message, onDismiss]);

    const urgent = message.priority !== 'routine';
    return (
        <Animated.View
            entering={FadeInUp.springify().damping(18)}
            exiting={FadeOutUp.duration(180)}
            style={[styles.wrap, { top }]}
        >
            <Pressable
                accessibilityRole="alert"
                onPress={onPress}
                style={[styles.card, urgent && { backgroundColor: C.primary }]}
            >
                <Text style={[font.heading, urgent && { color: C.onPrimary }]} numberOfLines={1}>
                    {message.title}
                </Text>
                <Text
                    style={[font.body, urgent && { color: 'rgba(255,255,255,0.88)' }]}
                    numberOfLines={2}
                >
                    {message.body}
                </Text>
            </Pressable>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', left: 12, right: 12, zIndex: 20 },
    card: {
        backgroundColor: C.bg,
        borderRadius: 16,
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 2,
        ...shadow,
        elevation: 12,
    },
});
