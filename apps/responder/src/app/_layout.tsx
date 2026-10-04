import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider } from '../state/store';
import { C } from '../ui/theme';

export default function RootLayout() {
    return (
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
            <SafeAreaProvider>
                <StoreProvider>
                    <StatusBar style="dark" />
                    <Stack
                        screenOptions={{
                            headerShown: false,
                            contentStyle: { backgroundColor: C.bg },
                            animation: 'fade',
                        }}
                    >
                        <Stack.Screen name="index" />
                        <Stack.Screen name="zone" options={{ gestureEnabled: false }} />
                    </Stack>
                </StoreProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}
