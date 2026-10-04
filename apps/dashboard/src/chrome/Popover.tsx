import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './chrome.module.css';

interface Props {
    open: boolean;
    onClose: () => void;
    anchor: ReactNode;
    width?: number;
    align?: 'left' | 'right';
    children: ReactNode;
}

/** A small panel under its anchor; closes on outside click or Escape. */
export function Popover({ open, onClose, anchor, width = 340, align = 'right', children }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open, onClose]);

    return (
        <div ref={ref} className={styles.popoverHost}>
            {anchor}
            <AnimatePresence>
                {open ? (
                    <motion.div
                        className={styles.popover}
                        style={{ width, [align]: 0 }}
                        initial={{ opacity: 0, y: -8, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.14 } }}
                        transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                    >
                        {children}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
