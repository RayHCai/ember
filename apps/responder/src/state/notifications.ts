import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { ResponderMessage } from '@ember/contracts';

import type * as ExpoNotifications from 'expo-notifications';

type NotificationsModule = typeof ExpoNotifications;
type Notification = ExpoNotifications.Notification;

/**
 * Expo Go on Android throws as soon as expo-notifications is imported (SDK 53+), which takes every
 * route down with it, so the module is loaded lazily and skipped there. The feed poll still runs.
 */
const supported = !(
    Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
);

let mod: NotificationsModule | null | undefined;

function notifications(): NotificationsModule | null {
    if (mod !== undefined) return mod;
    mod = null;
    if (!supported) return mod;
    try {
        // oxlint-disable-next-line typescript/no-require-imports
        mod = require('expo-notifications') as NotificationsModule;
        mod.setNotificationHandler({
            handleNotification: async (n) => {
                const priority = (n.request.content.data as Partial<ResponderMessage> | null)
                    ?.priority;
                return {
                    shouldShowBanner: true,
                    shouldShowList: true,
                    shouldPlaySound: priority !== 'routine',
                    shouldSetBadge: true,
                };
            },
        });
    } catch {
        mod = null;
    }
    return mod;
}

/** Null where push is unavailable (Expo Go on Android, simulator, denied, no EAS project). */
export async function pushToken(): Promise<string | null> {
    const N = notifications();
    if (!N || !Device.isDevice) return null;
    try {
        if (Platform.OS === 'android') {
            await N.setNotificationChannelAsync('incidents', {
                name: 'Incidents',
                importance: N.AndroidImportance.MAX,
                vibrationPattern: [0, 250, 150, 250],
            });
        }
        const current = await N.getPermissionsAsync();
        const granted = current.granted || (await N.requestPermissionsAsync()).granted;
        if (!granted) return null;
        const projectId: unknown =
            Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
        if (typeof projectId !== 'string') return null;
        return (await N.getExpoPushTokenAsync({ projectId })).data;
    } catch {
        return null;
    }
}

function asMessage(n: Notification): ResponderMessage | null {
    const d = n.request.content.data as Partial<ResponderMessage> | null;
    if (!d || typeof d.id !== 'string' || typeof d.sentAt !== 'string') return null;
    return d as ResponderMessage;
}

/** Messages pushed while the app is open. Returns the unsubscribe. */
export function onPushedMessage(listener: (m: ResponderMessage) => void): () => void {
    const N = notifications();
    if (!N) return () => undefined;
    const sub = N.addNotificationReceivedListener((n) => {
        const m = asMessage(n);
        if (m) listener(m);
    });
    return () => sub.remove();
}

export function clearBadge(): void {
    void notifications()
        ?.setBadgeCountAsync(0)
        .catch(() => undefined);
}
