import { AnimatePresence, motion } from 'motion/react';
import { useEffect, type ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { IconButton } from './Button';
import styles from './ui.module.css';

interface Props {
    open: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    icon?: GlyphName;
    width?: number;
    children: ReactNode;
}

export function Modal({ open, onClose, title, subtitle, icon, width = 560, children }: Props) {
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
                    transition={{ duration: 0.2 }}
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
                        initial={{ opacity: 0, y: 24, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.97 }}
                        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                    >
                        <div className={styles.dialogHeader}>
                            {icon ? (
                                <motion.span
                                    className={styles.dialogIcon}
                                    initial={{ rotate: -20, scale: 0.6 }}
                                    animate={{ rotate: 0, scale: 1 }}
                                    transition={{
                                        type: 'spring',
                                        stiffness: 300,
                                        damping: 14,
                                        delay: 0.08,
                                    }}
                                >
                                    <Icon name={icon} size={22} />
                                </motion.span>
                            ) : null}
                            <div>
                                <h2 className={styles.dialogTitle}>{title}</h2>
                                {subtitle ? (
                                    <p className={styles.dialogSubtitle}>{subtitle}</p>
                                ) : null}
                            </div>
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
