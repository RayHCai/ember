import { Color, ScreenSpaceEventType, Viewer } from 'cesium';
import { useEffect, useRef } from 'react';
import { appLog } from '../shell';
import { registerBase } from './base';
import { setOverview } from './camera';
import { driveFrameClock } from './frameClock';
import { loadMap } from './mapSource';
import styles from './MapStage.module.css';
import { useMap } from './viewer';

const BACKGROUND = '#F1F0EC';

/**
 * The one map, created once and kept alive across pages so moving between a zone list
 * and a zone never reloads tiles. Pages that do not show it hide it and stop rendering.
 */
export function MapStage({ visible }: { visible: boolean }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const creditsRef = useRef<HTMLDivElement>(null);
    const viewer = useMap((s) => s.viewer);

    useEffect(() => {
        const container = containerRef.current;
        const credits = creditsRef.current;
        if (!container || !credits) return;
        const v = new Viewer(container, {
            baseLayer: false,
            animation: false,
            timeline: false,
            baseLayerPicker: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            navigationHelpButton: false,
            fullscreenButton: false,
            infoBox: false,
            selectionIndicator: false,
            creditContainer: credits,
            showRenderLoopErrors: false,
        });
        const { scene } = v;
        v.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
        v.cesiumWidget.screenSpaceEventHandler.removeInputAction(
            ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );
        scene.backgroundColor = Color.fromCssColorString(BACKGROUND);
        scene.globe.baseColor = Color.fromCssColorString('#E9E7E2');
        scene.globe.showGroundAtmosphere = false;
        scene.fog.enabled = false;
        if (scene.skyBox) scene.skyBox.show = false;
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
        // Top-down only: no tilting or free look.
        scene.screenSpaceCameraController.enableTilt = false;
        scene.screenSpaceCameraController.enableLook = false;
        setOverview(v, [37.5, -112]);
        const stopFrameClock = driveFrameClock(v);
        // A bad frame should cost one frame, not the map: log it and keep rendering.
        const stopErrorWatch = scene.renderError.addEventListener((_scene, error) => {
            appLog('error', `Map render error: ${String(error)}`);
            console.error('Map render error', error);
            window.setTimeout(() => {
                if (!v.isDestroyed()) v.useDefaultRenderLoop = true;
            }, 0);
        });

        void loadMap(v).then((loaded) => {
            if (!loaded || v.isDestroyed()) return;
            registerBase(loaded.setSaturation);
            useMap.getState().setSource(loaded.info);
            const { label, fallbackReason } = loaded.info;
            appLog(
                'info',
                `Map loaded: ${label}${fallbackReason ? ` (fallback: ${fallbackReason})` : ''}`,
            );
        });

        useMap.getState().setViewer(v);
        if (import.meta.env.DEV)
            (window as unknown as { __emberViewer?: Viewer }).__emberViewer = v;

        // StrictMode mounts twice in dev, so always tear down the viewer.
        return () => {
            stopFrameClock();
            stopErrorWatch();
            registerBase(null);
            useMap.getState().setViewer(null);
            useMap.getState().setSource(null);
            v.destroy();
            credits.replaceChildren();
        };
    }, []);

    useEffect(() => {
        if (!viewer) return;
        if (visible) {
            viewer.useDefaultRenderLoop = true;
            viewer.resize();
            return;
        }
        // Let the fade finish before the map stops drawing.
        const timer = window.setTimeout(() => {
            if (!viewer.isDestroyed()) viewer.useDefaultRenderLoop = false;
        }, 500);
        return () => window.clearTimeout(timer);
    }, [viewer, visible]);

    return (
        <div className={styles.stage} data-visible={visible} data-map-ready={viewer !== null}>
            <div ref={containerRef} className={styles.map} />
            <div ref={creditsRef} className={styles.credits} />
        </div>
    );
}
