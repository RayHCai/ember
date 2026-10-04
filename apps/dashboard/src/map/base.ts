import { prefersReducedMotion } from './camera';

// How much color the base map keeps. Detection mode drains it to black and white,
// with a short tween so the switch reads as one motion.

let setter: ((value: number) => void) | null = null;
let current = 1;
let target = 1;
let frame = 0;

export function registerBase(fn: ((value: number) => void) | null): void {
    setter = fn;
    fn?.(current);
}

export function tweenSaturation(to: number, ms = 650): void {
    target = to;
    cancelAnimationFrame(frame);
    if (prefersReducedMotion() || !setter) {
        current = to;
        setter?.(to);
        return;
    }
    const from = current;
    const start = performance.now();
    const step = () => {
        const t = Math.min(1, (performance.now() - start) / ms);
        const eased = 1 - (1 - t) ** 3;
        current = from + (target - from) * eased;
        setter?.(current);
        if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
}
