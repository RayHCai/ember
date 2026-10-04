import * as Device from 'expo-device';
import { useNetworkState } from 'expo-network';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import type {
    ResponderMessage,
    ResponderPairingCode,
    ResponderSession,
    ResponderZoneBundle,
} from '@ember/contracts';
import { DEMO_SESSION, demoBundle } from '../demo/bundle';
import { fetchBundle, pair } from '../lib/client';
import { mergeMessages } from '../lib/feed';
import { sorted } from '../lib/sorted';
import { clearBadge, onPushedMessage } from './notifications';
import { clearAll, loadAll, save, type FeedState } from './storage';

const SYNC_INTERVAL_MS = 30_000;

type State = {
    phase: 'booting' | 'unpaired' | 'ready';
    session: ResponderSession | null;
    bundle: ResponderZoneBundle | null;
    feed: FeedState;
    syncing: boolean;
    syncError: string | null;
    /** The latest message that arrived while the app was open, for the in-app banner. */
    banner: ResponderMessage | null;
};

type Action =
    | {
          type: 'loaded';
          session: ResponderSession | null;
          bundle: ResponderZoneBundle | null;
          feed: FeedState | null;
      }
    | { type: 'connected'; session: ResponderSession; bundle: ResponderZoneBundle; feed: FeedState }
    | { type: 'disconnected' }
    | { type: 'syncing' }
    | {
          type: 'synced';
          bundle: ResponderZoneBundle | null;
          incoming: ResponderMessage[];
          at: string;
      }
    | { type: 'syncFailed'; error: string }
    | { type: 'messages'; incoming: ResponderMessage[]; banner: boolean }
    | { type: 'read'; at: string }
    | { type: 'dismissBanner' };

const EMPTY_FEED: FeedState = { messages: [], lastReadAt: null, lastSyncedAt: null };

const initial: State = {
    phase: 'booting',
    session: null,
    bundle: null,
    feed: EMPTY_FEED,
    syncing: false,
    syncError: null,
    banner: null,
};

function newest(
    current: ResponderMessage[],
    incoming: ResponderMessage[],
): ResponderMessage | null {
    const known = new Set(current.map((m) => m.id));
    return (
        sorted(
            incoming.filter((m) => !known.has(m.id)),
            (a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt),
        )[0] ?? null
    );
}

function reducer(state: State, action: Action): State {
    switch (action.type) {
        case 'loaded':
            return action.session && action.bundle
                ? {
                      ...state,
                      phase: 'ready',
                      session: action.session,
                      bundle: action.bundle,
                      feed: action.feed ?? EMPTY_FEED,
                  }
                : { ...state, phase: 'unpaired' };
        case 'connected':
            return {
                ...initial,
                phase: 'ready',
                session: action.session,
                bundle: action.bundle,
                feed: action.feed,
            };
        case 'disconnected':
            return { ...initial, phase: 'unpaired' };
        case 'syncing':
            return { ...state, syncing: true };
        case 'synced': {
            const banner = newest(state.feed.messages, action.incoming);
            return {
                ...state,
                syncing: false,
                syncError: null,
                bundle: action.bundle ?? state.bundle,
                feed: {
                    ...state.feed,
                    messages: mergeMessages(state.feed.messages, action.incoming),
                    lastSyncedAt: action.at,
                },
                banner: banner ?? state.banner,
            };
        }
        case 'syncFailed':
            return { ...state, syncing: false, syncError: action.error };
        case 'messages': {
            const banner = action.banner ? newest(state.feed.messages, action.incoming) : null;
            return {
                ...state,
                feed: {
                    ...state.feed,
                    messages: mergeMessages(state.feed.messages, action.incoming),
                },
                banner: banner ?? state.banner,
            };
        }
        case 'read':
            return { ...state, feed: { ...state.feed, lastReadAt: action.at } };
        case 'dismissBanner':
            return { ...state, banner: null };
    }
}

type Store = State & {
    online: boolean;
    connect: (code: ResponderPairingCode) => Promise<void>;
    connectDemo: () => Promise<void>;
    disconnect: () => void;
    syncNow: () => void;
    markRead: () => void;
    dismissBanner: () => void;
};

const StoreContext = createContext<Store | null>(null);

const isDemo = (s: ResponderSession) => s.apiUrl === DEMO_SESSION.apiUrl;

export function StoreProvider({ children }: { children: ReactNode }) {
    const [state, dispatch] = useReducer(reducer, initial);
    const net = useNetworkState();
    const online = net.isInternetReachable ?? net.isConnected ?? false;
    const stateRef = useRef(state);
    useLayoutEffect(() => {
        stateRef.current = state;
    });

    useEffect(() => {
        void loadAll().then(({ session, bundle, feed }) =>
            dispatch({ type: 'loaded', session, bundle, feed }),
        );
    }, []);

    // Persist the feed whenever it changes; the bundle and session are written when they arrive.
    useEffect(() => {
        if (state.phase === 'ready') void save.feed(state.feed);
    }, [state.phase, state.feed]);

    const finishConnect = useCallback(
        async (session: ResponderSession, bundle: ResponderZoneBundle) => {
            const feed: FeedState = {
                messages: bundle.messages,
                lastReadAt: null,
                lastSyncedAt: new Date().toISOString(),
            };
            await Promise.all([save.session(session), save.bundle(bundle), save.feed(feed)]);
            dispatch({ type: 'connected', session, bundle, feed });
        },
        [],
    );

    const connect = useCallback(
        async (code: ResponderPairingCode) => {
            const session = await pair(code, {
                deviceName: Device.deviceName ?? Device.modelName ?? 'Responder',
                platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
            });
            const bundle = await fetchBundle(session, null, 60_000);
            if (!bundle) throw new Error('The server sent no zone data.');
            await finishConnect(session, bundle);
        },
        [finishConnect],
    );

    const connectDemo = useCallback(async () => {
        await finishConnect(DEMO_SESSION, demoBundle());
    }, [finishConnect]);

    const disconnect = useCallback(() => {
        clearAll();
        clearBadge();
        dispatch({ type: 'disconnected' });
    }, []);

    const syncNow = useCallback(() => {
        const { session, bundle, syncing } = stateRef.current;
        if (!session || syncing || isDemo(session)) return;
        dispatch({ type: 'syncing' });
        void (async () => {
            try {
                const fresh = await fetchBundle(session, bundle?.version ?? null);
                if (fresh) await save.bundle(fresh);
                dispatch({
                    type: 'synced',
                    bundle: fresh,
                    incoming: fresh?.messages ?? [],
                    at: new Date().toISOString(),
                });
            } catch (e) {
                dispatch({
                    type: 'syncFailed',
                    error: e instanceof Error ? e.message : 'Sync failed',
                });
            }
        })();
    }, []);

    // While open and online, stay in step with the dashboard; offline, the saved bundle is the map.
    useEffect(() => {
        if (state.phase !== 'ready' || !online) return;
        syncNow();
        let timer = setInterval(syncNow, SYNC_INTERVAL_MS);
        const sub = AppState.addEventListener('change', (s) => {
            clearInterval(timer);
            if (s === 'active') {
                syncNow();
                timer = setInterval(syncNow, SYNC_INTERVAL_MS);
            }
        });
        return () => {
            clearInterval(timer);
            sub.remove();
        };
    }, [state.phase, online, syncNow]);

    useEffect(
        () =>
            onPushedMessage((m) => {
                if (m.zoneId === stateRef.current.session?.zoneId) {
                    dispatch({ type: 'messages', incoming: [m], banner: false });
                }
            }),
        [],
    );

    const markRead = useCallback(() => {
        dispatch({ type: 'read', at: new Date().toISOString() });
        clearBadge();
    }, []);

    const dismissBanner = useCallback(() => dispatch({ type: 'dismissBanner' }), []);

    const value = useMemo<Store>(
        () => ({
            ...state,
            online,
            connect,
            connectDemo,
            disconnect,
            syncNow,
            markRead,
            dismissBanner,
        }),
        [state, online, connect, connectDemo, disconnect, syncNow, markRead, dismissBanner],
    );
    return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
    const s = useContext(StoreContext);
    if (!s) throw new Error('useStore outside StoreProvider');
    return s;
}
