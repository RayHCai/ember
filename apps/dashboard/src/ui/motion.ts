import type { Transition } from 'motion/react';

// One motion language for the whole app: quick, eased, no overshoot.

export const EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];

/** Hovers, small reveals, exits. */
export const QUICK: Transition = { duration: 0.16, ease: EASE };

/** Pages, panels, anything that travels. */
export const SMOOTH: Transition = { duration: 0.34, ease: EASE };

/** Things that follow a control: sliding pills, knobs, list reflow. */
export const SNAP: Transition = { type: 'spring', stiffness: 560, damping: 44 };
