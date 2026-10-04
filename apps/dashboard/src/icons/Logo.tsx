import { motion, useReducedMotion } from 'motion/react';
import { MARK_FACETS } from './glyphs';

interface LogoProps {
    size?: number;
    /** Facets fly in and settle into the mark. */
    assemble?: boolean;
    /** A slow flicker runs across the facets. */
    alive?: boolean;
    className?: string;
}

function centroid(points: string): [number, number] {
    const pts = points.split(' ').map((p) => p.split(',').map(Number));
    return [
        pts.reduce((s, p) => s + p[0]!, 0) / pts.length,
        pts.reduce((s, p) => s + p[1]!, 0) / pts.length,
    ];
}

/** The Ember mark, identical to assets/brand/icon.svg. */
export function Logo({ size = 32, assemble = false, alive = false, className }: LogoProps) {
    const reduced = useReducedMotion();
    const animate = assemble && !reduced;
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 1024 1024"
            className={className}
            role="img"
            aria-label="Ember"
            style={{ flexShrink: 0, overflow: 'visible' }}
        >
            <motion.rect
                x="40"
                y="40"
                width="944"
                height="944"
                rx="212"
                fill="#000"
                initial={animate ? { scale: 0.6, opacity: 0 } : false}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 220, damping: 22 }}
                style={{ transformOrigin: '512px 512px' }}
            />
            <g transform="translate(512 512) scale(1.14) translate(-513 -509)">
                {MARK_FACETS.map((points, i) => {
                    const [cx, cy] = centroid(points);
                    const dx = (cx - 513) * 0.9;
                    const dy = (cy - 509) * 0.9 + 60;
                    return (
                        <motion.polygon
                            key={points}
                            points={points}
                            fill="#fff"
                            stroke="#000"
                            strokeWidth={18}
                            strokeLinejoin="round"
                            initial={
                                animate
                                    ? { opacity: 0, x: dx, y: dy, rotate: (i % 2 ? 1 : -1) * 40 }
                                    : false
                            }
                            animate={
                                alive && !reduced
                                    ? { opacity: [1, 0.72, 1], x: 0, y: 0, rotate: 0 }
                                    : { opacity: 1, x: 0, y: 0, rotate: 0 }
                            }
                            transition={
                                alive && !reduced
                                    ? {
                                          opacity: {
                                              duration: 2.4,
                                              repeat: Infinity,
                                              delay: 1.2 + i * 0.17,
                                              ease: 'easeInOut',
                                          },
                                          default: {
                                              type: 'spring',
                                              stiffness: 160,
                                              damping: 18,
                                              delay: 0.15 + i * 0.045,
                                          },
                                      }
                                    : {
                                          type: 'spring',
                                          stiffness: 160,
                                          damping: 18,
                                          delay: 0.15 + i * 0.045,
                                      }
                            }
                            style={{ transformOrigin: `${cx}px ${cy}px`, transformBox: 'view-box' }}
                        />
                    );
                })}
            </g>
        </svg>
    );
}

/** Mark plus wordmark, for headers. */
export function Wordmark({ size = 26 }: { size?: number }) {
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Logo size={size} />
            <span style={{ fontWeight: 650, fontSize: size * 0.66, letterSpacing: '-0.02em' }}>
                Ember
            </span>
        </span>
    );
}
