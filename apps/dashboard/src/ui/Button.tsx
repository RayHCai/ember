import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { Spinner } from './Spinner';
import styles from './ui.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: 'sm' | 'md' | 'lg';
    icon?: GlyphName;
    iconAfter?: GlyphName;
    loading?: boolean;
    block?: boolean;
    children?: ReactNode;
}

export function Button({
    variant = 'secondary',
    size = 'md',
    icon,
    iconAfter,
    loading = false,
    block = false,
    className,
    children,
    disabled,
    ...rest
}: ButtonProps) {
    const classes = [
        styles.button,
        variant !== 'secondary' ? styles[variant] : '',
        size !== 'md' ? styles[size] : '',
        block ? styles.block : '',
        className ?? '',
    ].join(' ');
    const iconSize = size === 'sm' ? 15 : 17;
    return (
        <button
            type="button"
            className={classes}
            disabled={disabled || loading}
            data-nudge={
                iconAfter === 'arrowRight' || iconAfter === 'chevronRight'
                    ? 'right'
                    : icon === 'arrowLeft'
                      ? 'left'
                      : undefined
            }
            {...rest}
        >
            {loading ? (
                <Spinner size={iconSize} />
            ) : icon ? (
                <Icon name={icon} size={iconSize} />
            ) : null}
            {children}
            {iconAfter && !loading ? <Icon name={iconAfter} size={iconSize - 2} /> : null}
        </button>
    );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon: GlyphName;
    label: string;
    active?: boolean;
    count?: number;
    /** Tooltip below the button. */
    tip?: boolean;
}

export function IconButton({
    icon,
    label,
    active,
    count,
    tip = true,
    className,
    ...rest
}: IconButtonProps) {
    return (
        <button
            type="button"
            aria-label={label}
            data-tip={tip ? label : undefined}
            data-active={active}
            className={`${styles.iconButton} ${tip ? styles.tip : ''} ${className ?? ''}`}
            {...rest}
        >
            <Icon name={icon} size={18} />
            {count ? <span className={styles.badge}>{count > 9 ? '9+' : count}</span> : null}
        </button>
    );
}
