import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

interface Props {
    value: number;
    decimals?: number;
    suffix?: string;
    duration?: number;
}

/** A number that rolls to its new value instead of jumping. */
export function CountUp({ value, decimals = 0, suffix = '', duration = 0.9 }: Props) {
    const ref = useRef<HTMLSpanElement>(null);
    const from = useRef(0);
    const reduced = useReducedMotion();

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const format = (v: number) => `${v.toFixed(decimals)}${suffix}`;
        if (reduced) {
            el.textContent = format(value);
            from.current = value;
            return;
        }
        const controls = animate(from.current, value, {
            duration,
            ease: [0.22, 1, 0.36, 1],
            onUpdate: (v) => {
                el.textContent = format(v);
                from.current = v;
            },
        });
        return () => controls.stop();
    }, [value, decimals, suffix, duration, reduced]);

    return (
        <span ref={ref} className="mono">
            {`${(0).toFixed(decimals)}${suffix}`}
        </span>
    );
}
