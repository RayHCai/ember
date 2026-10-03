import type { LatLon } from "../types/events";
import { attempt, request } from "./api";
import { demoPlayer } from "./source";

// Operator actions. In demo mode the demo player answers; otherwise they go to
// the logic service (which answers "not available" until it supports them).

export async function approveAlert(approvalId: string): Promise<void> {
  const demo = demoPlayer();
  if (demo) return demo.approve(approvalId);
  await attempt("Approving the alert", () => request(`/approvals/${approvalId}/approve`, { method: "POST" }));
}

export async function holdAlert(approvalId: string): Promise<void> {
  const demo = demoPlayer();
  if (demo) return demo.hold(approvalId);
  await attempt("Holding the alert", () => request(`/approvals/${approvalId}/hold`, { method: "POST" }));
}

/** Returns false if the point was rejected (outside the zone). */
export async function startTestFire(zoneId: string, at: LatLon): Promise<boolean> {
  const demo = demoPlayer();
  if (demo) return demo.startFireAt(at);
  const res = await attempt("Starting a test fire", () =>
    request(`/zones/${zoneId}/incidents`, { method: "POST", json: { lat: at[0], lon: at[1], test: true } }),
  );
  return res !== undefined;
}

export async function dispatchDrones(incidentId: string): Promise<void> {
  const demo = demoPlayer();
  if (demo) return demo.dispatchSuppression();
  await attempt("Dispatching drones", () => request(`/incidents/${incidentId}/suppression`, { method: "POST" }));
}

export async function sendChat(zoneId: string | null, text: string): Promise<string | undefined> {
  const demo = demoPlayer();
  if (demo) return demo.chat(text);
  const res = await attempt("Sending to the agent", () =>
    request<{ reply: string }>("/agent/chat", { method: "POST", json: { zone_id: zoneId, text } }),
  );
  return res?.reply;
}
