import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react';
import { useEffect } from 'react';
import { LoginPage } from './auth/LoginPage';
import { MapStage } from './map/MapStage';
import { SetupPage } from './setup/SetupPage';
import { startFleetHeartbeat } from './sim/scan';
import { pageKey, useRouter, type Route } from './store/router';
import { useSession, watchSessionExpiry } from './store/session';
import { Toasts } from './ui/Toasts';
import { ZonePage } from './zone/ZonePage';
import { ZonesPage } from './zones/ZonesPage';
import styles from './Shell.module.css';

const ease = [0.22, 1, 0.36, 1] as const;

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

    useEffect(() => watchSessionExpiry(), []);
    useEffect(() => startFleetHeartbeat(), []);

    return (
        <MotionConfig reducedMotion="user">
            <LayoutGroup>
                {session ? <MapStage visible={onMap} /> : null}
                <AnimatePresence initial={false}>
                    {session ? (
                        <motion.div
                            key={pageKey(route)}
                            className={styles.page}
                            data-on-map={onMap}
                            initial={
                                onMap
                                    ? { opacity: 0 }
                                    : { opacity: 0, scale: 0.985, filter: 'blur(6px)' }
                            }
                            // A lingering filter would stop the glass panels from blurring what is behind them.
                            animate={
                                onMap
                                    ? { opacity: 1 }
                                    : {
                                          opacity: 1,
                                          scale: 1,
                                          filter: 'blur(0px)',
                                          transitionEnd: { filter: 'none' },
                                      }
                            }
                            exit={
                                onMap
                                    ? { opacity: 0, transition: { duration: 0.3 } }
                                    : {
                                          opacity: 0,
                                          scale: 1.02,
                                          filter: 'blur(8px)',
                                          transition: { duration: 0.45, ease },
                                      }
                            }
                            transition={{ duration: 0.5, ease }}
                        >
                            <Page route={route} />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="login"
                            className={styles.page}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{
                                opacity: 0,
                                scale: 1.03,
                                filter: 'blur(10px)',
                                transition: { duration: 0.5, ease },
                            }}
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
