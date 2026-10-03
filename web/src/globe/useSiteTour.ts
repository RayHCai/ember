import { Cartesian3, HeadingPitchRange, Math as CesiumMath, Matrix4, type Viewer } from "cesium";
import { useEffect, useRef } from "react";
import { selectActiveZone, useAppStore, type FilterId } from "../state/store";
import { pushToast } from "../state/toasts";
import { flyToPoint, flyToPoints, prefersReducedMotion } from "./camera";
import { captureView, waitForTiles } from "./capture";

const ORBIT_RAD_PER_FRAME = 0.0018;

/** Slow orbit around a point until stopped or the operator touches the map. */
function startOrbit(viewer: Viewer, lat: number, lon: number): () => void {
  const center = Cartesian3.fromDegrees(lon, lat, 0);
  let heading = viewer.camera.heading;
  const pitch = viewer.camera.pitch;
  const range = Cartesian3.distance(viewer.camera.positionWC, center);
  let stopped = false;
  const removeFrame = viewer.scene.preRender.addEventListener(() => {
    heading += ORBIT_RAD_PER_FRAME;
    viewer.camera.lookAt(center, new HeadingPitchRange(heading, pitch, range));
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeFrame();
    canvas.removeEventListener("pointerdown", stop);
    canvas.removeEventListener("wheel", stop);
    if (!viewer.isDestroyed()) viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  };
  const canvas = viewer.scene.canvas;
  canvas.addEventListener("pointerdown", stop);
  canvas.addEventListener("wheel", stop, { passive: true });
  return stop;
}

/**
 * The report's signature moment. Selecting a site flies to an oblique view,
 * takes a photo if the site has none, switches to the Thermal filter and
 * orbits slowly. A new report first sweeps from the zone into site 1.
 */
export function useSiteTour(): void {
  const viewer = useAppStore((s) => s.viewer);
  const siteId = useAppStore((s) => s.selectedSiteId);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const report = useAppStore((s) => (zoneId ? s.reports[zoneId] : undefined));
  const panel = useAppStore((s) => s.rightPanel);
  const previousFilter = useRef<FilterId | null>(null);
  // The report object last swept, not its id: a replayed demo reuses ids.
  const sweptReport = useRef<object | null>(null);

  // A newly opened report: sweep in from the zone overview to site 1.
  useEffect(() => {
    if (!viewer || !report || panel !== "report" || sweptReport.current === report) return;
    sweptReport.current = report;
    const first = report.sites[0];
    if (!first) return;
    pushToast("New vulnerability report. It is open on the right.", "info", {
      label: "Close report",
      run: () => {
        useAppStore.getState().selectSite(null);
        useAppStore.getState().setRightPanel("agent");
      },
    });
    const zone = selectActiveZone(useAppStore.getState());
    if (zone && !prefersReducedMotion()) {
      void flyToPoints(viewer, zone.polygon, { duration: 2 }).then(() => useAppStore.getState().selectSite(first.id));
    } else {
      useAppStore.getState().selectSite(first.id);
    }
  }, [viewer, report, panel]);

  useEffect(() => {
    if (!viewer) return;
    const site = report?.sites.find((s) => s.id === siteId);
    const store = useAppStore.getState();
    if (!site) {
      if (previousFilter.current !== null) {
        store.setFilter(previousFilter.current);
        previousFilter.current = null;
      }
      return;
    }
    let cancelled = false;
    let stopOrbit: (() => void) | null = null;
    if (previousFilter.current === null) previousFilter.current = store.filter;
    store.setFilter("normal");

    void (async () => {
      const heading = CesiumMath.toDegrees(viewer.camera.heading);
      await flyToPoint(viewer, site.lat, site.lon, { range: 2400, pitchDeg: -28, headingDeg: heading, duration: 2.5 });
      if (cancelled) return;
      const s = useAppStore.getState();
      const real = site.capture_id ? s.captures[site.capture_id]?.image_url : null;
      if (real) {
        s.setSitePhoto(site.id, { url: real, simulated: false, label: "Drone capture" });
      } else if (!s.sitePhotos[site.id]) {
        await waitForTiles(viewer);
        if (cancelled || viewer.isDestroyed()) return;
        s.setSitePhoto(site.id, { url: captureView(viewer), simulated: true, label: "Simulated capture from 3D map" });
      }
      if (cancelled) return;
      useAppStore.getState().setFilter("thermal");
      if (!prefersReducedMotion()) stopOrbit = startOrbit(viewer, site.lat, site.lon);
    })();

    return () => {
      cancelled = true;
      stopOrbit?.();
    };
  }, [viewer, siteId, report]);
}
