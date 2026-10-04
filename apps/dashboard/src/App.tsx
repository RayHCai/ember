import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react';
import { useEffect } from 'react';
import { LoginPage } from './auth/LoginPage';
import { MapStage } from './map/MapStage';
import { SetupPage } from './setup/SetupPage';
import { connectDroneInfo } from './live/droneInfo';
import { pageKey, useRouter, type Route } from './store/router';
import { checkSession, useSession, watchSessionExpiry } from './store/session';
import { QUICK, SMOOTH } from './ui/motion';
import { Toasts } from './ui/Toasts';
import { ZonePage } from './zone/ZonePage';
import { ZonesPage } from './zones/ZonesPage';
import styles from './Shell.module.css';

function Page({ route }: { route: Route }) {
    switch (route.name) {
        case 'zones':
            return <ZonesPage />;
        case 'new':
            return <SetupPage zoneId={null} step="boundary" />;
        case 'setup':
            return <SetupPage zoneId={route.zoneId} step={route.step} />;
        case 'zone':
            return <ZonePage zoneId={route.zoneId} />;
    }
}

export function App() {
    const session = useSession((s) => s.session);
    const route = useRouter((s) => s.route);
    const onMap = route.name !== 'zones';

    const signedIn = session !== null;

    useEffect(() => watchSessionExpiry(), []);
    useEffect(() => void checkSession(), []);
    useEffect(() => (signedIn ? connectDroneInfo() : undefined), [signedIn]);

    return (
        <MotionConfig reducedMotion="user">
            <LayoutGroup>
                {session ? <MapStage visible={onMap} /> : null}
                <AnimatePresence initial={false}>
                    {session ? (
                        // Map pages fade only: their panels slide in on their own.
                        <motion.div
                            key={pageKey(route)}
                            className={styles.page}
                            data-on-map={onMap}
                            initial={{ opacity: 0, y: onMap ? 0 : 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, transition: QUICK }}
                            transition={SMOOTH}
                        >
                            <Page route={route} />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="login"
                            className={styles.page}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0, scale: 0.985, transition: SMOOTH }}
                        >
                            <LoginPage />
                        </motion.div>
                    )}
                </AnimatePresence>
                <Toasts />
            </LayoutGroup>
        </MotionConfig>
    );
}
