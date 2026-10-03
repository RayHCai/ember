import type { EdgePlan, EdgeServer, LatLon, Shelter, Zone } from "../types/events";
import { request } from "./api";

export const zonesApi = {
  create: (name: string, polygon: LatLon[], elevation?: [number, number, number][]) =>
    request<Zone>("/zones", { method: "POST", json: { name, polygon, elevation } }),

  remove: (zoneId: string) => request<{ ok: boolean }>(`/zones/${zoneId}`, { method: "DELETE" }),

  suggestEdgeServers: (zoneId: string) => request<EdgePlan>(`/zones/${zoneId}/edge-plan`, { method: "POST" }),

  setEdgeServers: (zoneId: string, servers: EdgeServer[], deploy: boolean) =>
    request<EdgePlan>(`/zones/${zoneId}/edge-servers`, {
      method: "POST",
      json: { servers: servers.map(({ id, lat, lon, radius_m }) => ({ id, lat, lon, radius_m })), deploy },
    }),

  setShelters: (zoneId: string, shelters: Shelter[]) =>
    request<{ shelters: Shelter[] }>(`/zones/${zoneId}/shelters`, { method: "PUT", json: { shelters } }),
};
