import { useRef } from "react";
import styles from "./App.module.css";
import { useEventSource } from "./data/useEventSource";
import { Globe } from "./globe/Globe";
import { GlobeLayers } from "./globe/GlobeLayers";
import { useOpeningFlight } from "./globe/useOpeningFlight";
import { useHotkeys } from "./hooks/useHotkeys";
import { AgentPanel } from "./hud/AgentPanel";
import credits from "./hud/Attribution.module.css";
import { BottomDock } from "./hud/BottomDock";
import { CursorReadout } from "./hud/CursorReadout";
import { LayersPanel } from "./hud/LayersPanel";
import { MapBadge } from "./hud/MapBadge";
import { Toasts } from "./hud/Toasts";
import { TopBar } from "./hud/TopBar";
import { ZonePanel } from "./hud/ZonePanel";
import { useAppStore } from "./state/store";

export function App() {
  const creditRef = useRef<HTMLDivElement>(null);
  const globeReady = useAppStore((s) => s.viewer !== null);
  const filter = useAppStore((s) => s.filter);

  useEventSource();
  useHotkeys();
  useOpeningFlight();

  return (
    <main data-globe-ready={globeReady} data-filter={filter}>
      <Globe creditContainer={creditRef} />
      <GlobeLayers />
      <div className={styles.hud}>
        <TopBar />
        <div className={styles.left}>
          <LayersPanel />
          <ZonePanel />
        </div>
        <AgentPanel />
        <div className={styles.bottomLeft}>
          <MapBadge />
          <CursorReadout />
          <div ref={creditRef} className={credits.credits} />
        </div>
        <div className={styles.bottomCenter}>
          <BottomDock />
        </div>
      </div>
      <Toasts />
    </main>
  );
}
