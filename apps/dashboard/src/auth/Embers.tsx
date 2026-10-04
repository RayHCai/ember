import { useMemo } from 'react';
import styles from './LoginPage.module.css';

const COLORS = ['#FFB347', '#FF8A3D', '#F2541B', '#E2341D', '#FFD08A'];

/** Faceted embers drifting up from the bottom of the hero. */
export function Embers({ count = 22 }: { count?: number }) {
    const embers = useMemo(
        () =>
            Array.from({ length: count }, (_, i) => {
                const r = (n: number) =>
                    (((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
                return {
                    left: `${4 + r(1) * 92}%`,
                    size: 6 + r(2) * 12,
                    delay: `${-r(3) * 9}s`,
                    duration: `${6 + r(4) * 7}s`,
                    drift: `${(r(5) - 0.5) * 120}px`,
                    spin: `${(r(6) - 0.5) * 540}deg`,
                    color: COLORS[i % COLORS.length]!,
                };
            }),
        [count],
    );
    return (
        <div className={styles.embers} aria-hidden>
            {embers.map((e, i) => (
                <svg
                    key={i}
                    className={styles.ember}
                    width={e.size}
                    height={e.size}
                    viewBox="0 0 10 10"
                    style={{
                        left: e.left,
                        animationDelay: e.delay,
                        animationDuration: e.duration,
                        ['--drift' as string]: e.drift,
                        ['--spin' as string]: e.spin,
                    }}
                >
                    <polygon points="5,0 10,8 0,9" fill={e.color} />
                </svg>
            ))}
        </div>
    );
}
