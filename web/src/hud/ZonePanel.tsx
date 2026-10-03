import { useState } from "react";
import { config } from "../config";
import { attempt } from "../data/api";
import { zonesApi } from "../data/zonesApi";
import { sampleElevations } from "../geo/elevation";
import { computeCoverage, polygonAreaKm2 } from "../geo/grid";
import { flyToPoints } from "../globe/camera";
import { cx, formatDuration } from "../lib/format";
import { selectActiveZone, simNow, useAppStore } from "../state/store";
import { pushToast } from "../state/toasts";
import type { Zone } from "../types/events";
import hud from "./hud.module.css";
import styles from "./ZonePanel.module.css";

const NEEDS_SERVER = "Needs the Ember server. The mock stream is on.";

function flyToZone(zone: Zone) {
  const viewer = useAppStore.getState().viewer;
  if (viewer) void flyToPoints(viewer, zone.polygon, { duration: 2 });
}

function DrawSteps() {
  const draft = useAppStore((s) => s.zoneDraft);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const points = draft?.points ?? [];
  const area = polygonAreaKm2(points);

  const cancel = () => {
    useAppStore.getState().setTool(null);
    useAppStore.getState().setZoneDraft(null);
  };

  const save = async () => {
    const { viewer, mapSource } = useAppStore.getState();
    if (!viewer || !draft?.closed) return;
    setSaving("Reading terrain heights");
    const elevation = await sampleElevations(viewer, mapSource?.id, points);
    setSaving("Fetching roads and places from OpenStreetMap");
    const zone = await attempt("Saving the zone", () => zonesApi.create(name.trim(), points, elevation));
    setSaving(null);
    if (!zone) return;
    cancel();
    useAppStore.getState().setActiveZone(zone.id);
    flyToZone(zone);
  };

  return (
    <div className={styles.section}>
      {!draft?.closed ? (
        <p className={styles.help}>
          Click the map to add points. Click the first point or double-click to close the zone. Backspace removes
          the last point. Esc cancels.
        </p>
      ) : (
        <p className={styles.help}>Drag points to adjust the outline, then name the zone and save it.</p>
      )}
      <div className={styles.stat}>
        <span className={hud.label}>Points</span>
        <span className={hud.mono}>{points.length}</span>
        <span className={hud.label}>Area</span>
        <span className={hud.mono} data-testid="draft-area">
          {points.length >= 3 ? `${area.toFixed(2)} km²` : "--"}
        </span>
      </div>
      {draft?.closed && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className={hud.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Zone name"
            aria-label="Zone name"
            autoFocus
            maxLength={80}
          />
          <div className={styles.actions}>
            <button type="submit" className={cx(hud.button, hud.primary)} disabled={!name.trim() || saving !== null}>
              {saving ? "Saving" : "Save zone"}
            </button>
            <button type="button" className={hud.button} onClick={cancel} disabled={saving !== null}>
              Cancel
            </button>
          </div>
          {saving && <p className={styles.progress}>{saving}</p>}
        </form>
      )}
      {!draft?.closed && (
        <div className={styles.actions}>
          <button type="button" className={hud.button} onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function ZoneList() {
  const zones = useAppStore((s) => s.zones);
  const activeId = useAppStore((s) => s.activeZoneId);
  const list = Object.values(zones);
  if (list.length === 0) {
    return (
      <div className={hud.empty}>
        <strong>No watch zone yet</strong>
        Choose New zone and click around the area to watch. A forested ridge above a town is a good start.
      </div>
    );
  }
  return (
    <ul className={styles.list}>
      {list.map((z) => (
        <li key={z.id}>
          <button
            type="button"
            className={cx(styles.zoneRow, z.id === activeId && styles.zoneRowOn)}
            onClick={() => {
              useAppStore.getState().setActiveZone(z.id);
              flyToZone(z);
            }}
          >
            <span className={styles.zoneName}>{z.name}</span>
            <span className={cx(hud.mono, hud.muted)}>{z.area_km2.toFixed(1)} km²</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MapSourceNote({ zoneId }: { zoneId: string }) {
  const map = useAppStore((s) => s.zoneMaps[zoneId]);
  if (!map) return null;
  if (map.source === "synthetic") {
    return (
      <div className={styles.offline} data-testid="osm-fallback">
        <span>
          Offline: OpenStreetMap unavailable. Using a synthetic road grid. <span className={hud.simTag}>SIM</span>
        </span>
      </div>
    );
  }
  return (
    <p className={styles.source}>
      {map.roads.length} roads and {map.communities.length} communities from{" "}
      {map.source === "cache" ? "cached OpenStreetMap data" : "OpenStreetMap"}.
      {map.elevation === "flat" && " No terrain heights, so slope uses flat ground."}
    </p>
  );
}

function EdgeServersStep({ zone }: { zone: Zone }) {
  const plan = useAppStore((s) => s.edgePlans[zone.id]);
  const draft = useAppStore((s) => (s.edgeDraft?.zoneId === zone.id ? s.edgeDraft : null));
  const grid = useAppStore((s) => s.zoneMaps[zone.id]?.grid);
  const [busy, setBusy] = useState(false);
  const { setTool, setEdgeDraft } = useAppStore.getState();

  const suggest = async () => {
    setBusy(true);
    const res = await attempt("Suggesting edge servers", () => zonesApi.suggestEdgeServers(zone.id));
    setBusy(false);
    if (res) setTool({ kind: "edit-edge", zoneId: zone.id });
  };

  const deploy = async () => {
    if (!draft) return;
    if (draft.servers.length === 0) {
      pushToast("Add at least one edge server before deploying.", "error");
      return;
    }
    setBusy(true);
    const res = await attempt("Deploying edge servers", () => zonesApi.setEdgeServers(zone.id, draft.servers, true));
    setBusy(false);
    if (res) {
      setEdgeDraft(null);
      setTool(null);
    }
  };

  const discard = async () => {
    const wasDeployed = plan?.servers.some((s) => s.status === "deployed");
    setTool(null);
    setEdgeDraft(null);
    // A suggestion that was never deployed is dropped on the server too.
    if (!wasDeployed) await attempt("Discarding the suggestion", () => zonesApi.setEdgeServers(zone.id, [], false));
  };

  if (draft && grid) {
    const pct = computeCoverage(grid, draft.servers).pct;
    return (
      <div className={styles.step}>
        <div className={styles.stepTitle}>Edge servers</div>
        <div className={styles.stat}>
          <span className={hud.label}>Servers</span>
          <span className={hud.mono}>{draft.servers.length}</span>
          <span className={hud.label}>Coverage</span>
          <span className={hud.mono} data-testid="coverage-pct">
            {pct.toFixed(1)}%
          </span>
        </div>
        <p className={styles.help}>Drag a server to move it. Click the map to add one. Right-click a server to remove it.</p>
        <div className={styles.actions}>
          <button type="button" className={cx(hud.button, hud.primary)} onClick={() => void deploy()} disabled={busy}>
            Deploy edge servers
          </button>
          <button type="button" className={hud.button} onClick={() => void discard()} disabled={busy}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  const deployed = plan?.servers.filter((s) => s.status === "deployed") ?? [];
  if (deployed.length > 0 && plan) {
    return (
      <div className={styles.step}>
        <div className={styles.stepTitle}>Edge servers</div>
        <p className={styles.done}>
          {deployed.length} deployed. Coverage <span className={hud.mono}>{plan.coverage_pct.toFixed(1)}%</span>.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={hud.button}
            disabled={config.useMock}
            title={config.useMock ? NEEDS_SERVER : undefined}
            onClick={() => {
              setEdgeDraft({ zoneId: zone.id, servers: plan.servers.map((s) => ({ ...s, status: "pending" })) });
              setTool({ kind: "edit-edge", zoneId: zone.id });
            }}
          >
            Edit edge servers
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepTitle}>Edge servers</div>
      <p className={styles.help}>Ember suggests drone dock sites near roads that together cover the zone.</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={cx(hud.button, hud.primary)}
          onClick={() => void suggest()}
          disabled={busy || config.useMock}
          title={config.useMock ? NEEDS_SERVER : undefined}
        >
          {busy ? "Planning" : "Suggest edge servers"}
        </button>
      </div>
    </div>
  );
}

function SurveysStep({ zone }: { zone: Zone }) {
  const deployed = useAppStore((s) => s.edgePlans[zone.id]?.servers.some((srv) => srv.status === "deployed") ?? false);
  const survey = useAppStore((s) => s.surveys[zone.id]);
  const sim = useAppStore((s) => s.sim);
  const [busy, setBusy] = useState(false);
  if (!deployed) return null;

  const running = survey?.status === "running";
  const run = async () => {
    setBusy(true);
    await attempt("Starting the survey", () => zonesApi.runSurvey(zone.id));
    setBusy(false);
  };

  return (
    <div className={styles.step}>
      <div className={styles.stepTitle}>
        Surveys <span className={hud.simTag}>SIM</span>
      </div>
      {running ? (
        <p className={styles.done}>
          Survey running: <span className={hud.mono}>{Math.round(survey.progress_pct)}%</span> imaged.
        </p>
      ) : survey?.last_completed ? (
        <p className={styles.done}>
          Last survey observed <span className={hud.mono}>{survey.observed_pct?.toFixed(1)}%</span> of the zone
          {survey.missed_count ? `, ${survey.missed_count} cells missed` : ""}.
        </p>
      ) : (
        <p className={styles.help}>Drones survey the zone every 12 hours and charge on their docks in between.</p>
      )}
      {!running && survey?.next_at && sim && (
        <p className={styles.help}>
          Next survey in <span className={hud.mono}>{formatDuration(Date.parse(survey.next_at) - simNow(sim))}</span>.
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={cx(hud.button, hud.primary)}
          onClick={() => void run()}
          disabled={busy || running || config.useMock}
          title={config.useMock ? NEEDS_SERVER : undefined}
        >
          Run survey
        </button>
      </div>
    </div>
  );
}

function SheltersStep({ zone }: { zone: Zone }) {
  const shelters = useAppStore((s) => s.zoneMaps[zone.id]?.shelters ?? []);
  const draft = useAppStore((s) => (s.shelterDraft?.zoneId === zone.id ? s.shelterDraft : null));
  const [busy, setBusy] = useState(false);
  const { setTool, setShelterDraft } = useAppStore.getState();

  const stop = () => {
    setShelterDraft(null);
    setTool(null);
  };

  if (draft) {
    const rename = (id: string, name: string) =>
      setShelterDraft({ ...draft, shelters: draft.shelters.map((s) => (s.id === id ? { ...s, name } : s)) });
    const save = async () => {
      setBusy(true);
      const res = await attempt("Saving shelters", () => zonesApi.setShelters(zone.id, draft.shelters));
      setBusy(false);
      if (res) stop();
    };
    return (
      <div className={styles.step}>
        <div className={styles.stepTitle}>Shelters</div>
        <p className={styles.help}>Click the map to add a shelter. Drag to move. Right-click to remove.</p>
        <ul className={styles.shelters}>
          {draft.shelters.map((s) => (
            <li key={s.id}>
              <input
                className={hud.input}
                value={s.name}
                aria-label="Shelter name"
                onChange={(e) => rename(s.id, e.target.value)}
              />
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <button type="button" className={cx(hud.button, hud.primary)} onClick={() => void save()} disabled={busy}>
            Save shelters
          </button>
          <button type="button" className={hud.button} onClick={stop} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepTitle}>Shelters</div>
      {shelters.length === 0 ? (
        <p className={styles.help}>No shelters yet. Evacuation routes need at least one.</p>
      ) : (
        <ul className={styles.names}>
          {shelters.map((s) => (
            <li key={s.id}>{s.name}</li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={hud.button}
          disabled={config.useMock}
          title={config.useMock ? NEEDS_SERVER : undefined}
          onClick={() => {
            setShelterDraft({ zoneId: zone.id, shelters });
            setTool({ kind: "edit-shelters", zoneId: zone.id });
          }}
        >
          Edit shelters
        </button>
      </div>
    </div>
  );
}

function RemoveZone({ zone }: { zone: Zone }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <button type="button" className={styles.linkButton} onClick={() => setConfirm(true)} disabled={config.useMock}>
        Remove zone
      </button>
    );
  }
  return (
    <div className={styles.confirm}>
      <span>Remove {zone.name}?</span>
      <button
        type="button"
        className={hud.button}
        onClick={() => void attempt("Removing the zone", () => zonesApi.remove(zone.id))}
      >
        Remove
      </button>
      <button type="button" className={hud.button} onClick={() => setConfirm(false)}>
        Keep
      </button>
    </div>
  );
}

export function ZonePanel() {
  const drawing = useAppStore((s) => s.tool?.kind === "draw-zone");
  const zone = useAppStore(selectActiveZone);

  const startDrawing = () => {
    const { setTool, setZoneDraft, setEdgeDraft, setShelterDraft } = useAppStore.getState();
    setEdgeDraft(null);
    setShelterDraft(null);
    setZoneDraft({ points: [], closed: false });
    setTool({ kind: "draw-zone" });
  };

  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Zones">
      <div className={hud.header}>
        <h2 className={hud.title}>{drawing ? "New zone" : "Zones"}</h2>
        {!drawing && (
          <button
            type="button"
            className={cx(hud.button, styles.small)}
            onClick={startDrawing}
            disabled={config.useMock}
            title={config.useMock ? NEEDS_SERVER : undefined}
          >
            New zone
          </button>
        )}
      </div>
      <div className={cx(styles.body, hud.scroll)}>
        {drawing ? (
          <DrawSteps />
        ) : (
          <>
            <ZoneList />
            {zone && (
              <div className={styles.section}>
                <MapSourceNote zoneId={zone.id} />
                <EdgeServersStep zone={zone} />
                <SurveysStep zone={zone} />
                <SheltersStep zone={zone} />
                <RemoveZone zone={zone} />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
