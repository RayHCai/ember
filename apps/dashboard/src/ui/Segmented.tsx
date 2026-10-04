import { motion } from 'motion/react';
import { useId } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import styles from './ui.module.css';

export interface SegmentOption<T extends string> {
    value: T;
    label: string;
    icon?: GlyphName;
    disabled?: boolean;
    title?: string;
}

interface Props<T extends string> {
    value: T;
    options: SegmentOption<T>[];
    onChange: (value: T) => void;
    label: string;
    className?: string;
}

/** Choices with a pill that slides to the active one. */
export function Segmented<T extends string>({
    value,
    options,
    onChange,
    label,
    className,
}: Props<T>) {
    const id = useId();
    return (
        <div
            role="radiogroup"
            aria-label={label}
            className={`${styles.segmented} ${className ?? ''}`}
        >
            {options.map((o) => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-active={active}
                        disabled={o.disabled}
                        title={o.title}
                        className={styles.segment}
                        onClick={() => onChange(o.value)}
                    >
                        {active ? (
                            <motion.span
                                layoutId={`segment-${id}`}
                                className={styles.segmentPill}
                                transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                            />
                        ) : null}
                        <span className={styles.segmentLabel}>
                            {o.icon ? <Icon name={o.icon} size={15} /> : null}
                            {o.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
