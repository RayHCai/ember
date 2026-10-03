import { useState, type FormEvent } from "react";
import { demoPlayer, startDemo } from "../data/source";
import { flyToPoint } from "../globe/camera";
import { PRESETS } from "../globe/presets";
import { geocode, geocoderLabel, type GeocodeResult } from "../geo/geocode";
import { cx } from "../lib/format";
import { useAppStore } from "../state/store";
import hud from "./hud.module.css";
import styles from "./BottomDock.module.css";

function flyToResult(result: GeocodeResult) {
  const viewer = useAppStore.getState().viewer;
  if (!viewer) return;
  const range = Math.min(Math.max(result.extentM * 1.6, 3000), 400_000);
  void flyToPoint(viewer, result.lat, result.lon, { range, duration: 2.5 });
}

function LocationSearch() {
  const mapId = useAppStore((s) => s.mapSource?.id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [attribution, setAttribution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const viewer = useAppStore.getState().viewer;
    if (!query.trim() || !viewer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await geocode(query.trim(), mapId, viewer.scene);
      setResults(response.results);
      setAttribution(response.attribution);
      if (response.results.length === 1) {
        flyToResult(response.results[0]!);
        setResults(null);
      }
    } catch (err) {
      setResults(null);
      setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.search}>
      <form onSubmit={onSubmit} className={styles.searchForm} role="search">
        <input
          className={cx(hud.input, styles.searchInput)}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a place"
          aria-label="Search a place"
        />
        <button type="submit" className={hud.button} disabled={busy || !query.trim()}>
          {busy ? "Searching" : "Search"}
        </button>
      </form>
      {(results || error) && (
        <div className={cx(hud.panel, styles.results)}>
          {error && <div className={styles.error}>{error}</div>}
          {results?.length === 0 && <div className={hud.empty}>No places found. Try a town or park name.</div>}
          {results?.map((r) => (
            <button
              key={`${r.lat},${r.lon},${r.name}`}
              type="button"
              className={styles.result}
              onClick={() => {
                flyToResult(r);
                setResults(null);
              }}
            >
              {r.name}
            </button>
          ))}
          <div className={styles.attribution}>
            {attribution || `Search by ${geocoderLabel(mapId)}`}
            <button type="button" className={styles.close} onClick={() => { setResults(null); setError(null); }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ZonePresets() {
  return (
    <select
      className={cx(hud.input, styles.presets)}
      aria-label="Fly to a preset location"
      value=""
      onChange={(e) => {
        const preset = PRESETS.find((p) => p.id === e.target.value);
        const viewer = useAppStore.getState().viewer;
        if (preset && viewer) void flyToPoint(viewer, preset.lat, preset.lon, { range: preset.range });
      }}
    >
      <option value="" disabled>
        Presets
      </option>
      {PRESETS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function DemoControls() {
  const demo = useAppStore((s) => s.demo);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const tool = useAppStore((s) => s.tool);
  const firing = tool?.kind === "test-fire";

  const testFire = (
    <button
      type="button"
      className={cx(hud.button, firing && hud.primary)}
      disabled={!zoneId}
      title="Click a point in the zone to start a simulated fire there"
      onClick={() => useAppStore.getState().setTool(firing || !zoneId ? null : { kind: "test-fire", zoneId })}
    >
      {firing ? "Click the map" : "Start test fire"} <span className={hud.simTag}>SIM</span>
    </button>
  );

  if (demo.status === "idle" || !demoPlayer()) {
    return (
      <div className={styles.demo}>
        {demoPlayer() && (
          <button type="button" className={cx(hud.button, hud.primary)} onClick={() => startDemo({ autoplay: true })}>
            Run demo
          </button>
        )}
        {testFire}
      </div>
    );
  }

  return <span className={hud.label}>Demo running</span>;
}

/** Demo controls, in their own bar above the dock while a demo runs. */
export function DemoBar() {
  const demo = useAppStore((s) => s.demo);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const tool = useAppStore((s) => s.tool);
  if (demo.status === "idle") return null;
  const firing = tool?.kind === "test-fire";
  const testFire = (
    <button
      type="button"
      className={cx(hud.button, firing && hud.primary)}
      disabled={!zoneId}
      title="Click a point in the zone to start a simulated fire there"
      onClick={() => useAppStore.getState().setTool(firing || !zoneId ? null : { kind: "test-fire", zoneId })}
    >
      {firing ? "Click the map" : "Start test fire"} <span className={hud.simTag}>SIM</span>
    </button>
  );
  const playing = demo.status === "playing";
  return (
    <div className={cx(hud.panel, styles.dock, styles.demo)} data-testid="demo-controls">
      <span className={styles.demoStep}>
        <span className={hud.label}>{demo.mode === "story" ? `Step ${demo.step + 1} of ${demo.steps}` : "Running"}</span>
        <span className={styles.demoLabel}>{demo.label}</span>
      </span>
      <button
        type="button"
        className={cx(hud.button, !playing && hud.primary)}
        onClick={() => (playing ? demoPlayer()?.pause() : demoPlayer()?.play())}
      >
        {playing ? "Pause" : demo.status === "done" ? "Replay" : "Play"}
      </button>
      <button type="button" className={hud.button} onClick={() => demoPlayer()?.next()} disabled={demo.status === "done"}>
        Next step
      </button>
      <button type="button" className={hud.button} onClick={() => startDemo()}>
        {demo.mode === "story" ? "Reset demo" : "Run full demo"}
      </button>
      {testFire}
    </div>
  );
}

export function BottomDock() {
  return (
    <div className={cx(hud.panel, styles.dock)}>
      <LocationSearch />
      <span className={styles.rule} />
      <ZonePresets />
      <span className={styles.rule} />
      <DemoControls />
    </div>
  );
}
