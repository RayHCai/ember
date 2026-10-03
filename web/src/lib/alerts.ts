import { projector } from "../geo/grid";
import type { AppState } from "../state/store";
import type { Notification, Resident, Route, Tier } from "../types/events";

const NEAR_M = 2000;

export interface AlertAt {
  /** Nearest simulated resident within 2 km, if any. */
  resident: Resident | null;
  tier: Tier | null;
  notification: (Notification & { ts?: string }) | null;
  route: Route | null;
}

/**
 * The alert that applies at a spot: the tier of the nearest resident the
 * service tiered, and the latest alert sent to that tier. The console does not
 * compute tiers itself; it reads them from the recipients event.
 */
export function alertAt(s: AppState, zoneId: string | null, at: [number, number], incidentId?: string): AlertAt {
  const recipients = zoneId ? s.recipients[zoneId] : undefined;
  const none: AlertAt = { resident: null, tier: null, notification: null, route: null };
  if (!recipients) return none;
  const project = projector(at);
  let nearest: Resident | null = null;
  let best = Infinity;
  for (const r of recipients.residents) {
    const [x, y] = project([r.lat, r.lon]);
    const d = Math.hypot(x, y);
    if (d < best) {
      best = d;
      nearest = r;
    }
  }
  if (!nearest || best > NEAR_M) return none;
  const tier = nearest.tier;
  const notification = tier
    ? ([...s.notifications].reverse().find((n) => n.tier === tier && (!incidentId || !n.incident_id || n.incident_id === incidentId)) ?? null)
    : null;
  const routes = zoneId ? s.routes[zoneId] : undefined;
  const route = notification?.route_id && routes ? (routes[notification.route_id] ?? null) : null;
  return { resident: nearest, tier, notification, route };
}
