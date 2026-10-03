import { Viewer } from "cesium";
import { useEffect, useRef } from "react";
import { useAppStore } from "../state/store";
import styles from "./Globe.module.css";

export function Globe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const setGlobeReady = useAppStore((s) => s.setGlobeReady);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // No base imagery yet: Prompt 1 adds the map fallback chain.
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
    });
    setGlobeReady(true);

    // StrictMode mounts twice in dev, so always tear down the viewer.
    return () => {
      setGlobeReady(false);
      viewer.destroy();
    };
  }, [setGlobeReady]);

  return <div ref={containerRef} className={styles.globe} />;
}
