import { AnimatePresence, motion } from 'motion/react';
import { useEffect, type ReactNode } from 'react';
import { IconButton } from './Button';
import { QUICK, SMOOTH } from './motion';
import styles from './ui.module.css';

interface Props {
    open: boolean;
    onClose: () => void;
    title: string;
    width?: number;
    children: ReactNode;
}

export function Modal({ open, onClose, title, width = 560, children }: Props) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    return (
        <AnimatePresence>
            {open ? (
                <motion.div
                    className={styles.backdrop}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={QUICK}
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    <motion.div
                        role="dialog"
                        aria-modal="true"
                        aria-label={title}
                        className={styles.dialog}
                        style={{ width: `min(${width}px, 100%)` }}
                        initial={{ opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.99, transition: QUICK }}
                        transition={SMOOTH}
                    >
                        <div className={styles.dialogHeader}>
                            <h2 className={styles.dialogTitle}>{title}</h2>
                            <IconButton
                                icon="close"
                                label="Close"
                                tip={false}
                                className={styles.dialogClose}
                                onClick={onClose}
                            />
                        </div>
                        <div className={styles.dialogBody}>{children}</div>
                    </motion.div>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}
