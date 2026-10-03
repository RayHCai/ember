import { useEffect, useRef, useState } from "react";
import { startDataSource } from "../data/source";
import { alertAt } from "../lib/alerts";
import { NONE, cx, formatClock } from "../lib/format";
import { selectActiveIncident, useAppStore } from "../state/store";
import type { Tier } from "../types/events";
import styles from "./ResidentApp.module.css";

// The resident page (/alert): a phone registers where it is and shows the
// alert for that spot as it arrives. Everything it shows in this build is
// simulated, and the page says so.

const TIER: Record<Tier, { label: string; headline: string }> = {
  evacuate: { label: "Evacuate", headline: "Leave now" },
  prepare: { label: "Prepare", headline: "Be ready to leave" },
  watch: { label: "Watch", headline: "Stay alert" },
};

interface Home {
  lat: number;
  lon: number;
  label: string;
}

const STORAGE_KEY = "ember.resident.home";

function loadHome(): Home | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Home) : null;
  } catch {
    return null;
  }
}

function saveHome(home: Home | null): void {
  try {
    if (home) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(home));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: the page still works, it just forgets on reload */
  }
}

export function ResidentApp() {
  const [home, setHome] = useState<Home | null>(loadHome);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const [permission, setPermission] = useState(() => ("Notification" in window ? Notification.permission : "unsupported"));
  const connection = useAppStore((s) => s.connection);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const communities = useAppStore((s) => (zoneId ? (s.zoneMaps[zoneId]?.communities ?? NONE) : NONE));
  const incident = useAppStore(selectActiveIncident);
  useAppStore((s) => s.notifications);
  useAppStore((s) => (zoneId ? s.recipients[zoneId] : undefined));
  const alert = home && incident ? alertAt(useAppStore.getState(), zoneId, [home.lat, home.lon], incident.id) : null;
  const note = alert?.notification ?? null;
  const announced = useRef<string | null>(null);

  // With dummy data, the page plays the demo story so alerts arrive on their own.
  useEffect(() => startDataSource({ story: true }), []);

  const register = (next: Home | null) => {
    setHome(next);
    saveHome(next);
  };

  const useMyLocation = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("This browser cannot share its location. Choose your town instead.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        register({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: "your location" });
      },
      (err) => {
        setLocating(false);
        setGeoError(err.code === err.PERMISSION_DENIED ? "Location access was denied. Choose your town instead." : "Could not find your location. Choose your town instead.");
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  // A new alert: system notification (if allowed) and sound (if enabled).
  useEffect(() => {
    if (!note || announced.current === note.id) return;
    announced.current = note.id;
    if (permission === "granted") {
      try {
        new Notification(`Ember: ${TIER[note.tier].label}`, { body: note.text });
      } catch {
        /* some browsers only allow notifications from a service worker */
      }
    }
    if (sound) {
      if (note.audio_url) void new Audio(note.audio_url).play().catch(() => undefined);
      else if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(note.text));
    }
  }, [note, permission, sound]);

  const status = connection === "mock" ? "Demo alerts" : connection === "open" ? "Connected" : "Connecting";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.product}>EMBER</span>
        <span className={styles.title}>Resident alerts</span>
        <span className={cx(styles.status, connection === "open" && styles.statusOn)}>{status}</span>
      </header>

      {!home ? (
        <section className={styles.card}>
          <h1 className={styles.h1}>Get wildfire alerts for where you are</h1>
          <button type="button" className={styles.primary} onClick={useMyLocation} disabled={locating}>
            {locating ? "Finding you" : "Use my location"}
          </button>
          {geoError && <p className={styles.error}>{geoError}</p>}
          {communities.length > 0 && (
            <label className={styles.field}>
              Or choose your town
              <select
                className={styles.select}
                value=""
                onChange={(e) => {
                  const c = communities.find((x) => x.id === e.target.value);
                  if (c) register({ lat: c.lat + 0.006, lon: c.lon, label: c.name });
                }}
              >
                <option value="" disabled>
                  Choose a town
                </option>
                {communities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      ) : (
        <>
          <section className={styles.registered} data-testid="resident-home">
            Alerts for <strong>{home.label}</strong>
            <button type="button" className={styles.link} onClick={() => register(null)}>
              Change
            </button>
          </section>

          {note && alert?.tier ? (
            <section className={cx(styles.alert, styles[alert.tier])} data-testid="resident-alert" role="alert">
              <div className={styles.alertHead}>
                <span className={styles.tier}>{TIER[alert.tier].label}</span>
                <span className={styles.time}>{note.ts ? formatClock(note.ts) : ""}</span>
              </div>
              <h1 className={styles.headline}>{TIER[alert.tier].headline}</h1>
              <p className={styles.text}>{note.text}</p>
              {alert.route && (
                <p className={styles.detail}>
                  Route: {alert.route.community} to {alert.route.shelter}, {alert.route.distance_km.toFixed(1)} km, about{" "}
                  {alert.route.eta_min} min.
                </p>
              )}
              {note.shelter && <p className={styles.detail}>Shelter: {note.shelter}</p>}
            </section>
          ) : (
            <section className={styles.card} data-testid="resident-clear">
              <h1 className={styles.h1}>No alerts for your location</h1>
              <p className={styles.muted}>This page updates on its own when an alert is sent.</p>
            </section>
          )}

          <section className={styles.controls}>
            {!sound ? (
              <button type="button" className={styles.secondary} onClick={() => setSound(true)}>
                Tap to enable sound
              </button>
            ) : (
              <p className={styles.muted}>Sound is on. Alerts will be read aloud.</p>
            )}
            {permission === "default" && (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void Notification.requestPermission().then(setPermission)}
              >
                Allow notifications
              </button>
            )}
          </section>
        </>
      )}

      <footer className={styles.footer}>
        Demo alerts only. Every alert on this page is simulated. Keep this page open: alerts arrive while it is on screen.
      </footer>
    </div>
  );
}
