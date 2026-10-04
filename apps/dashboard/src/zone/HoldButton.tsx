import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import styles from './BlastDialog.module.css';

interface Props {
    label: string;
    holdingLabel: string;
    onComplete: () => void;
    ms?: number;
}

/** A deliberate action: press and hold until the bar fills. */
export function HoldButton({ label, holdingLabel, onComplete, ms = 1200 }: Props) {
    const [holding, setHolding] = useState(false);
    const [progress, setProgress] = useState(0);
    const done = useRef(false);
    const complete = useRef(onComplete);
    complete.current = onComplete;

    useEffect(() => {
        if (!holding || done.current) return;
        const start = performance.now();
        let frame = 0;
        const step = () => {
            const t = (performance.now() - start) / ms;
            if (t >= 1) {
                setProgress(1);
                done.current = true;
                complete.current();
                return;
            }
            setProgress(t);
            frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, [holding, ms]);

    const begin = () => {
        if (!done.current) setHolding(true);
    };
    const cancel = () => {
        if (done.current) return;
        setHolding(false);
        setProgress(0);
    };

    return (
        <button
            type="button"
            className={styles.hold}
            data-holding={holding}
            onPointerDown={begin}
            onPointerUp={cancel}
            onPointerLeave={cancel}
            onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                    e.preventDefault();
                    begin();
                }
            }}
            onKeyUp={(e) => {
                if (e.key === 'Enter' || e.key === ' ') cancel();
            }}
        >
            <span className={styles.holdFill} style={{ transform: `scaleX(${progress})` }} />
            <span className={styles.holdLabel}>
                <Icon name="check" size={16} />
                {holding ? holdingLabel : label}
            </span>
        </button>
    );
}
