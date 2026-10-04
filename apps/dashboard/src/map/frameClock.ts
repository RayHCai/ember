import type { Viewer } from 'cesium';

// One timestamp per rendered frame. Animated properties read this instead of
// performance.now(), so values that must agree (an ellipse's two axes) always do.

let frameMs = performance.now();

export function frameSeconds(): number {
    return frameMs / 1000;
}

export function frameMilliseconds(): number {
    return frameMs;
}

export function driveFrameClock(viewer: Viewer): () => void {
    return viewer.scene.preRender.addEventListener(() => {
        frameMs = performance.now();
    });
}
