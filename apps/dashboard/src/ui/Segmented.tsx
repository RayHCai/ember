import { motion } from 'motion/react';
import { useId } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { SNAP } from './motion';
import styles from './ui.module.css';

export interface SegmentOption<T extends string> {
    value: T;
    label: string;
    icon?: GlyphName;
    count?: number;
    disabled?: boolean;
    title?: string;
}

interface Props<T extends string> {
    value: T;
    options: SegmentOption<T>[];
    onChange: (value: T) => void;
    label: string;
    /** `tabs` drops the track and underlines the active choice. */
    variant?: 'pill' | 'tabs';
    className?: string;
}

/** Choices with a marker that slides to the active one. */
export function Segmented<T extends string>({
    value,
    options,
    onChange,
    label,
    variant = 'pill',
    className,
}: Props<T>) {
    const id = useId();
    return (
        <div
            role="radiogroup"
            aria-label={label}
            className={`${variant === 'tabs' ? styles.tabs : styles.segmented} ${className ?? ''}`}
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
                                transition={SNAP}
                            />
                        ) : null}
                        <span className={styles.segmentLabel}>
                            {o.icon ? <Icon name={o.icon} size={14} /> : null}
                            {o.label}
                            {o.count ? (
                                <span className={styles.segmentCount}>{o.count}</span>
                            ) : null}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
