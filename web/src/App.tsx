import { useRef } from "react";
import styles from "./App.module.css";
import { useEventSource } from "./data/useEventSource";
import { Globe } from "./globe/Globe";
import { useOpeningFlight } from "./globe/useOpeningFlight";
import { useHotkeys } from "./hooks/useHotkeys";
import { AgentPanel } from "./hud/AgentPanel";
import credits from "./hud/Attribution.module.css";
import { BottomDock } from "./hud/BottomDock";
import { CursorReadout } from "./hud/CursorReadout";
import { LayersPanel } from "./hud/LayersPanel";
import { MapBadge } from "./hud/MapBadge";
import { TopBar } from "./hud/TopBar";
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
      <div className={styles.hud}>
        <TopBar />
        <LayersPanel />
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
    </main>
  );
}
