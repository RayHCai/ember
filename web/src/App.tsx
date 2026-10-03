import { useRef } from "react";
import styles from "./App.module.css";
import { useEventSource } from "./data/useEventSource";
import { Globe } from "./globe/Globe";
import { GlobeLayers } from "./globe/GlobeLayers";
import { useOpeningFlight } from "./globe/useOpeningFlight";
import { useSiteTour } from "./globe/useSiteTour";
import { useHotkeys } from "./hooks/useHotkeys";
import { AgentPanel } from "./hud/AgentPanel";
import credits from "./hud/Attribution.module.css";
import { BottomDock, DemoBar } from "./hud/BottomDock";
import { CursorReadout } from "./hud/CursorReadout";
import { DroneInspector } from "./hud/DroneInspector";
import { IncidentCard } from "./hud/IncidentCard";
import { LayersPanel } from "./hud/LayersPanel";
import { ReportPanel } from "./hud/ReportPanel";
import { ShortcutsOverlay } from "./hud/ShortcutsOverlay";
import { SuppressionBanner } from "./hud/SuppressionBanner";
import { MapBadge } from "./hud/MapBadge";
import { PanelBoundary } from "./hud/PanelBoundary";
import { PhonePreview } from "./hud/PhonePreview";
import { Toasts } from "./hud/Toasts";
import { TopBar } from "./hud/TopBar";
import { ZonePanel } from "./hud/ZonePanel";
import { useAppStore } from "./state/store";

export function App() {
  const creditRef = useRef<HTMLDivElement>(null);
  const globeReady = useAppStore((s) => s.viewer !== null);
  const filter = useAppStore((s) => s.filter);
  const rightPanel = useAppStore((s) => s.rightPanel);

  useEventSource();
  useHotkeys();
  useOpeningFlight();
  useSiteTour();

  return (
    <main data-globe-ready={globeReady} data-filter={filter}>
      <Globe creditContainer={creditRef} />
      <GlobeLayers />
      <div className={styles.hud}>
        <PanelBoundary name="Top bar">
          <TopBar />
        </PanelBoundary>
        <div className={styles.center}>
          <PanelBoundary name="Incident">
            <SuppressionBanner />
            <IncidentCard />
          </PanelBoundary>
          <Toasts />
          <PanelBoundary name="Phone preview">
            <PhonePreview />
          </PanelBoundary>
        </div>
        <div className={styles.left}>
          <PanelBoundary name="Layers">
            <LayersPanel />
          </PanelBoundary>
          <PanelBoundary name="Zones">
            <ZonePanel />
          </PanelBoundary>
        </div>
        <PanelBoundary name={rightPanel === "report" ? "Report" : "Agent"}>
          {rightPanel === "report" ? <ReportPanel /> : <AgentPanel />}
        </PanelBoundary>
        <div className={styles.bottomLeft}>
          <MapBadge />
          <CursorReadout />
          <div ref={creditRef} className={credits.credits} />
        </div>
        <div className={styles.bottomCenter}>
          <PanelBoundary name="Dock">
            <DroneInspector />
            <DemoBar />
            <BottomDock />
          </PanelBoundary>
        </div>
      </div>
      <ShortcutsOverlay />
    </main>
  );
}
