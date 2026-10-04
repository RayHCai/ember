import { zoomBy } from './camera';
import { useMap } from './viewer';
import styles from './ZoomControl.module.css';

/** Zoom in and out by a step; pinching the trackpad or scrolling over the map does the same. */
export function ZoomControl({ className }: { className?: string }) {
    const viewer = useMap((s) => s.viewer);
    return (
        <div className={`${styles.zoom} ${className ?? ''}`} role="group" aria-label="Zoom">
            <button
                type="button"
                aria-label="Zoom in"
                disabled={!viewer}
                onClick={() => viewer && zoomBy(viewer, 0.5)}
            >
                <svg viewBox="0 0 16 16" aria-hidden>
                    <path d="M8 3v10M3 8h10" />
                </svg>
            </button>
            <button
                type="button"
                aria-label="Zoom out"
                disabled={!viewer}
                onClick={() => viewer && zoomBy(viewer, 2)}
            >
                <svg viewBox="0 0 16 16" aria-hidden>
                    <path d="M3 8h10" />
                </svg>
            </button>
        </div>
    );
}
