import { Color, ScreenSpaceEventType, Viewer } from "cesium";
import { useEffect, useRef, type RefObject } from "react";
import { appLog } from "../shell";
import { useAppStore } from "../state/store";
import { setWholeEarthView } from "./camera";
import { applyFilter, createFilterStages } from "./filters";
import { loadMap } from "./mapSource";
import { DEFAULT_LOCATION } from "./presets";
import styles from "./Globe.module.css";

interface GlobeProps {
  /** Where Cesium renders data attribution, so it can sit inside the HUD. */
  creditContainer: RefObject<HTMLDivElement | null>;
}

export function Globe({ creditContainer }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setViewer = useAppStore((s) => s.setViewer);
  const setMapSource = useAppStore((s) => s.setMapSource);

  useEffect(() => {
    const container = containerRef.current;
    const credits = creditContainer.current;
    if (!container || !credits) return;

    const viewer = new Viewer(container, {
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
      // Keeps the canvas readable so site photos can be captured from the map.
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    });
    // Editing tools own clicks. Drop the viewer's own select and double-click zoom.
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    viewer.scene.backgroundColor = Color.fromCssColorString("#03070a");
    viewer.scene.globe.baseColor = Color.fromCssColorString("#0a1a20");
    setWholeEarthView(viewer, DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon);

    const stages = createFilterStages(viewer.scene);
    applyFilter(stages, useAppStore.getState().filter);
    const unsubscribeFilter = useAppStore.subscribe((s, prev) => {
      if (s.filter !== prev.filter && !viewer.isDestroyed()) applyFilter(stages, s.filter);
    });

    void loadMap(viewer).then((loaded) => {
      if (!loaded || viewer.isDestroyed()) return;
      setMapSource(loaded.info);
      const { label, fallbackReason } = loaded.info;
      appLog("info", `Map loaded: ${label}${fallbackReason ? ` (fallback: ${fallbackReason})` : ""}`);
    });

    setViewer(viewer);
    if (import.meta.env.DEV) (window as unknown as { __emberViewer?: Viewer }).__emberViewer = viewer;

    // StrictMode mounts twice in dev, so always tear down the viewer.
    return () => {
      unsubscribeFilter();
      setViewer(null);
      viewer.destroy();
      credits.replaceChildren();
    };
  }, [creditContainer, setViewer, setMapSource]);

  return <div ref={containerRef} className={styles.globe} />;
}
