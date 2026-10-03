import { Color, Viewer } from "cesium";
import { useEffect, useRef, type RefObject } from "react";
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
    });
    viewer.scene.backgroundColor = Color.fromCssColorString("#03070a");
    viewer.scene.globe.baseColor = Color.fromCssColorString("#0a1a20");
    setWholeEarthView(viewer, DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon);

    const stages = createFilterStages(viewer.scene);
    applyFilter(stages, useAppStore.getState().filter);
    const unsubscribeFilter = useAppStore.subscribe((s, prev) => {
      if (s.filter !== prev.filter && !viewer.isDestroyed()) applyFilter(stages, s.filter);
    });

    void loadMap(viewer).then((loaded) => {
      if (loaded && !viewer.isDestroyed()) setMapSource(loaded.info);
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
