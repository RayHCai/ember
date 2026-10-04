import {
    API_EDGE_SERVERS_PATH,
    BLASTS_PATH,
    DRONES_PATH,
    FOREST_FIT_PATH,
    MAPPING_RUNS_PATH,
    PLACEMENTS_PATH,
    PLANNER_JOBS_PATH,
    SESSION_PATH,
    SIGN_IN_PATH,
    SIGN_UP_PATH,
    WATCH_ZONES_PATH,
    ZONE_BLASTS_PATH,
    ZONE_PLACEMENTS_PATH,
    ZONE_RISK_ZONES_PATH,
    ZONE_SCANS_PATH,
    ZONE_SUMMARIES_PATH,
    ZONE_SURROUNDINGS_PATH,
    ZONE_WEATHER_PATH,
} from '@ember/contracts';
import type {
    Blast,
    CreateBlastRequest,
    CreatePlacementRequest,
    CreatePlannerJobRequest,
    CreateWatchZoneRequest,
    Drone,
    EdgeServer,
    EdgeServerPlacement,
    ForestFitResult,
    LatLng,
    MappingRun,
    OperatorSession,
    PlannerJob,
    RiskZonesView,
    Scan,
    SessionInfo,
    SignInRequest,
    SignUpRequest,
    SuggestPlacementsRequest,
    SuggestPlacementsResult,
    UpdateEdgeServerRequest,
    UpdatePlacementRequest,
    UpdateWatchZoneRequest,
    WatchZone,
    WatchZoneSummary,
    ZoneSurroundings,
    ZoneWeather,
} from '@ember/contracts';
import { fill, request } from './client';

type Signal = AbortSignal | undefined;

const zonePath = (path: string, zoneId: string) => fill(path, { zoneId });
const zone = (zoneId: string) => `${WATCH_ZONES_PATH}/${encodeURIComponent(zoneId)}`;

/** The api routes the dashboard uses, typed by `@ember/contracts`. */
export const api = {
    signUp: (body: SignUpRequest) =>
        request<OperatorSession>('POST', SIGN_UP_PATH, { body, auth: false }),
    signIn: (body: SignInRequest) =>
        request<OperatorSession>('POST', SIGN_IN_PATH, { body, auth: false }),
    session: (signal?: Signal) => request<SessionInfo>('GET', SESSION_PATH, { signal }),
    signOut: () => request<void>('DELETE', SESSION_PATH),

    summaries: (signal?: Signal) =>
        request<WatchZoneSummary[]>('GET', ZONE_SUMMARIES_PATH, { signal }),
    zone: (zoneId: string, signal?: Signal) => request<WatchZone>('GET', zone(zoneId), { signal }),
    createZone: (body: CreateWatchZoneRequest) =>
        request<WatchZone>('POST', WATCH_ZONES_PATH, { body }),
    updateZone: (zoneId: string, body: UpdateWatchZoneRequest) =>
        request<WatchZone>('PATCH', zone(zoneId), { body }),

    edgeServers: (query: { zoneId?: string; unassigned?: boolean }, signal?: Signal) =>
        request<EdgeServer[]>('GET', API_EDGE_SERVERS_PATH, { query, signal }),
    updateEdgeServer: (edgeServerId: string, body: UpdateEdgeServerRequest) =>
        request<EdgeServer>(
            'PATCH',
            `${API_EDGE_SERVERS_PATH}/${encodeURIComponent(edgeServerId)}`,
            {
                body,
            },
        ),

    placements: (zoneId: string, signal?: Signal) =>
        request<EdgeServerPlacement[]>('GET', zonePath(ZONE_PLACEMENTS_PATH, zoneId), { signal }),
    createPlacement: (zoneId: string, body: CreatePlacementRequest) =>
        request<EdgeServerPlacement>('POST', zonePath(ZONE_PLACEMENTS_PATH, zoneId), { body }),
    suggestPlacements: (zoneId: string, body: SuggestPlacementsRequest) =>
        request<SuggestPlacementsResult>(
            'POST',
            `${zonePath(ZONE_PLACEMENTS_PATH, zoneId)}/suggest`,
            { body },
        ),
    clearPlacements: (zoneId: string) =>
        request<void>('DELETE', zonePath(ZONE_PLACEMENTS_PATH, zoneId)),
    updatePlacement: (placementId: string, body: UpdatePlacementRequest) =>
        request<EdgeServerPlacement>('PATCH', `${PLACEMENTS_PATH}/${placementId}`, { body }),
    deletePlacement: (placementId: string) =>
        request<void>('DELETE', `${PLACEMENTS_PATH}/${placementId}`),
    assignPlacement: (placementId: string, edgeServerId: string) =>
        request<EdgeServer>('POST', `${PLACEMENTS_PATH}/${placementId}/assign`, {
            body: { edgeServerId },
        }),

    drones: (zoneId: string, signal?: Signal) =>
        request<Drone[]>('GET', DRONES_PATH, { query: { zoneId, limit: 1000 }, signal }),

    scans: (zoneId: string, limit: number, signal?: Signal) =>
        request<Scan[]>('GET', zonePath(ZONE_SCANS_PATH, zoneId), { query: { limit }, signal }),
    startScan: (zoneId: string) =>
        request<Scan>('POST', zonePath(ZONE_SCANS_PATH, zoneId), { body: {} }),
    stopScan: (zoneId: string, runId: string) =>
        request<Scan>(
            'POST',
            `${zonePath(ZONE_SCANS_PATH, zoneId)}/${encodeURIComponent(runId)}/stop`,
            { body: {} },
        ),
    mappingRuns: (query: { zoneId?: string; runId?: string; limit?: number }, signal?: Signal) =>
        request<MappingRun[]>('GET', MAPPING_RUNS_PATH, { query, signal }),

    riskZones: (zoneId: string, signal?: Signal) =>
        request<RiskZonesView>('GET', zonePath(ZONE_RISK_ZONES_PATH, zoneId), { signal }),
    surroundings: (zoneId: string, signal?: Signal) =>
        request<ZoneSurroundings>('GET', zonePath(ZONE_SURROUNDINGS_PATH, zoneId), {
            query: { roads: false },
            signal,
        }),
    weather: (zoneId: string, signal?: Signal) =>
        request<ZoneWeather>('GET', zonePath(ZONE_WEATHER_PATH, zoneId), { signal }),
    forestFit: (boundary: LatLng[]) =>
        request<ForestFitResult>('POST', FOREST_FIT_PATH, { body: { boundary } }),

    plannerJobs: (zoneId: string, limit: number, signal?: Signal) =>
        request<PlannerJob[]>('GET', `${zone(zoneId)}/planner-jobs`, {
            query: { limit },
            signal,
        }),
    plannerJob: (jobId: string, signal?: Signal) =>
        request<PlannerJob>('GET', `${PLANNER_JOBS_PATH}/${jobId}`, { signal }),
    createPlannerJob: (zoneId: string, body: CreatePlannerJobRequest) =>
        request<PlannerJob>('POST', `${zone(zoneId)}/planner-jobs`, { body }),

    blasts: (zoneId: string, signal?: Signal) =>
        request<Blast[]>('GET', zonePath(ZONE_BLASTS_PATH, zoneId), {
            query: { limit: 20 },
            signal,
        }),
    createBlast: (zoneId: string, body: CreateBlastRequest) =>
        request<Blast>('POST', zonePath(ZONE_BLASTS_PATH, zoneId), { body }),
    approveBlast: (blastId: string) =>
        request<Blast>('POST', `${BLASTS_PATH}/${blastId}/approve`, { body: {} }),
};
