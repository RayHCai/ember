import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { HEAT } from '../map/layers/SuggestionsLayer';
import type { OverlayMode } from '../store/ui';
import { QUICK, SNAP } from '../ui/motion';
import styles from './Overlay.module.css';

function Swatch({ color, ring, dashed }: { color: string; ring?: boolean; dashed?: boolean }) {
    return (
        <span
            className={styles.swatch}
            style={
                ring
                    ? {
                          border: `2px ${dashed ? 'dashed' : 'solid'} ${color}`,
                          background: `${color}22`,
                          borderRadius: 999,
                      }
                    : { background: color }
            }
        />
    );
}

function Item({ mark, label }: { mark: ReactNode; label: string }) {
    return (
        <span className={styles.legendItem}>
            {mark}
            {label}
        </span>
    );
}

const HEAT_CSS = `linear-gradient(90deg, ${HEAT.map(([r, g, b]) => `rgb(${r} ${g} ${b})`).join(', ')})`;

function Gradient({ left, right }: { left: string; right: string }) {
    return (
        <span className={styles.legendItem}>
            <span className={styles.gradLabel}>{left}</span>
            <span className={styles.gradient} style={{ background: HEAT_CSS }} />
            <span className={styles.gradLabel}>{right}</span>
        </span>
    );
}

/** What the colors on the map mean, for the overlay that is on. */
export function Legend({ mode, suggestions }: { mode: OverlayMode; suggestions: boolean }) {
    const key = suggestions ? 'suggestions' : mode;
    return (
        <motion.div layout className={styles.legend} transition={SNAP}>
            <AnimatePresence mode="wait" initial={false}>
                <motion.div
                    key={key}
                    className={styles.legendRow}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={QUICK}
                >
                    {key === 'operator' ? (
                        <>
                            <Item mark={<Icon name="server" size={14} />} label="Edge server" />
                            <Item mark={<Swatch color="#FF4FA3" ring dashed />} label="Pending" />
                            <Item
                                mark={<Swatch color="#FF4FA3" ring />}
                                label="Connectivity radius"
                            />
                            <Item mark={<Icon name="drone" size={14} />} label="Drone" />
                            <Item mark={<Swatch color="#2F6BFF" ring />} label="Boundary" />
                        </>
                    ) : key === 'detection' ? (
                        <>
                            <Item mark={<Swatch color="#C9C4BF" />} label="Not yet mapped" />
                            <Item mark={<Swatch color="#7CC69A" />} label="Mapped" />
                            <Item mark={<Swatch color="#F2A900" />} label="At risk" />
                            <Item mark={<Swatch color="#E5321F" />} label="On fire" />
                            <Item mark={<Swatch color="#E5321F" ring />} label="Detection box" />
                        </>
                    ) : (
                        <>
                            <Gradient left="Fire now" right="Later" />
                            <Item mark={<Swatch color="#12A37A" />} label="Evacuation route" />
                            <Item
                                mark={<Swatch color="#0E8FD8" ring dashed />}
                                label="Attack zone"
                            />
                            <Item
                                mark={<Swatch color="#111110" ring dashed />}
                                label="Forecast perimeter"
                            />
                        </>
                    )}
                </motion.div>
            </AnimatePresence>
        </motion.div>
    );
}
