import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { C } from './theme';

const SPRING = { damping: 26, stiffness: 260, mass: 0.9 };

type Props = {
    height: number;
    peek: number;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    header: ReactNode;
    children: ReactNode;
};

/** Two-stop bottom sheet: a peek that keeps the map in view, and an expanded list. */
export function Sheet({ height, peek, expanded, onExpandedChange, header, children }: Props) {
    const closed = height - peek;
    const y = useSharedValue(expanded ? 0 : closed);
    const startY = useSharedValue(0);

    useEffect(() => {
        y.value = withSpring(expanded ? 0 : closed, SPRING);
    }, [expanded, closed, y]);

    const drag = Gesture.Pan()
        .onStart(() => {
            startY.value = y.value;
        })
        .onUpdate((e) => {
            y.value = Math.min(Math.max(startY.value + e.translationY, -12), closed + 12);
        })
        .onEnd((e) => {
            const open = e.velocityY < -400 || (e.velocityY < 400 && y.value < closed / 2);
            y.value = withSpring(open ? 0 : closed, { ...SPRING, velocity: e.velocityY });
            scheduleOnRN(onExpandedChange, open);
        });

    const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

    return (
        <Animated.View style={[styles.sheet, { height }, style]}>
            <GestureDetector gesture={drag}>
                <View collapsable={false}>
                    <View style={styles.handleWrap}>
                        <View style={styles.handle} />
                    </View>
                    {header}
                </View>
            </GestureDetector>
            <View style={styles.body}>{children}</View>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    sheet: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: C.bg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        shadowColor: C.shadow,
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 1,
        shadowRadius: 20,
        elevation: 16,
        overflow: 'hidden',
    },
    handleWrap: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border },
    body: { flex: 1 },
});
