import { pushToast } from "../state/toasts";
import type { EdgePlan, EdgeServer, LatLon, Shelter, Zone } from "../types/events";
import { attempt, request } from "./api";
import { demoPlayer } from "./source";
import { zonesApi } from "./zonesApi";

// Operator actions. The built-in dummy backend answers them; if a logic
// service is configured instead, they go to it.

export async function createZone(name: string, polygon: LatLon[], elevation?: [number, number, number][]): Promise<Zone | undefined> {
  const demo = demoPlayer();
  if (demo) return demo.createZone(name, polygon);
  return attempt("Saving the zone", () => zonesApi.create(name, polygon, elevation));
}

export async function removeZone(zoneId: string): Promise<void> {
  const demo = demoPlayer();
  if (demo) return demo.removeZone(zoneId);
  await attempt("Removing the zone", () => zonesApi.remove(zoneId));
}

export async function suggestEdgeServers(zoneId: string): Promise<EdgePlan | undefined> {
  const demo = demoPlayer();
  if (demo) return demo.suggestEdgeServers(zoneId);
  return attempt("Suggesting edge servers", () => zonesApi.suggestEdgeServers(zoneId));
}

export async function setEdgeServers(zoneId: string, servers: EdgeServer[], deploy: boolean): Promise<EdgePlan | undefined> {
  const demo = demoPlayer();
  if (demo) return demo.setEdgeServers(zoneId, servers, deploy);
  return attempt(deploy ? "Deploying edge servers" : "Saving edge servers", () => zonesApi.setEdgeServers(zoneId, servers, deploy));
}

export async function setShelters(zoneId: string, shelters: Shelter[]): Promise<boolean> {
  const demo = demoPlayer();
  if (demo) {
    demo.setShelters(zoneId, shelters);
    return true;
  }
  return (await attempt("Saving shelters", () => zonesApi.setShelters(zoneId, shelters))) !== undefined;
}

export async function runSurvey(zoneId: string): Promise<void> {
  const demo = demoPlayer();
  if (demo) {
    const problem = demo.runSurvey(zoneId);
    if (problem) pushToast(problem, "error");
    return;
  }
  await attempt("Starting the survey", () => zonesApi.runSurvey(zoneId));
}

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
