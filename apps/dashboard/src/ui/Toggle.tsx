import { motion } from 'motion/react';
import { SNAP } from './motion';
import styles from './ui.module.css';

interface Props {
    on: boolean;
    onChange: (on: boolean) => void;
    label: string;
    disabled?: boolean;
}

export function Toggle({ on, onChange, label, disabled }: Props) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            data-on={on}
            disabled={disabled}
            className={styles.toggle}
            onClick={() => onChange(!on)}
        >
            <motion.span layout className={styles.knob} transition={SNAP} />
        </button>
    );
}
