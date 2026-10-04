import type { FastifyInstance } from 'fastify';
import {
    SCAN_STOP_PATH,
    ZONE_EDGE_SERVERS_PATH,
    ZONE_SCANS_PATH,
    type EdgeServerRecord,
    type Scan,
    type WatchZoneId,
} from '@ember/contracts';
import { guard, STAFF } from '../auth.js';
import { iso, requireZone, type Deps } from '../deps.js';
import { HttpError, notFound, parse } from '../errors.js';
import { circle, distanceM } from '../geo.js';
import * as s from '../schemas.js';
import type { StoredEdgeServer } from '../store/index.js';

const ALTITUDE = { minM: 60, maxM: 120 };

export function scanRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    app.get<{ Params: { zoneId: string } }>(ZONE_EDGE_SERVERS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        const servers = await store.edgeServers.list({ zoneId: req.params.zoneId as WatchZoneId });
        const live = await deps.edge.servers().catch((err: unknown) => {
            req.log.warn({ err }, 'edge-manager registry unavailable');
            return [];
        });
        return servers.map((e): EdgeServerRecord => ({
            edgeServerId: e.edgeServerId,
            url: e.url,
            name: e.name,
            zoneId: e.zoneId,
            location: e.location,
            connectivityRadiusM: e.connectivityRadiusM,
            live: live.find((l) => l.edgeServerId === e.edgeServerId) ?? null,
        }));
    });

    app.post<{ Params: { zoneId: string } }>(ZONE_EDGE_SERVERS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.registerEdgeServer, req.body);
        const record: StoredEdgeServer = {
            ...body,
            zoneId: zone.id,
            registeredAt: iso(deps.now()),
        };
        if (!(await store.edgeServers.insert(record))) {
            throw new HttpError(409, `edge server ${body.edgeServerId} is registered`);
        }
        return reply.code(201).send(record);
    });

    app.get<{ Params: { zoneId: string } }>(ZONE_SCANS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        return store.scans.list(
            { zoneId: req.params.zoneId as WatchZoneId },
            { orderBy: 'startedAt', desc: true },
        );
    });

    app.post<{ Params: { zoneId: string } }>(ZONE_SCANS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.startScan, req.body);
        const all = await store.edgeServers.list({ zoneId: zone.id });
        let chosen = body.edgeServerIds
            ? all.filter((e) => body.edgeServerIds!.includes(e.edgeServerId))
            : all;
        if (!body.edgeServerIds && body.focus) {
            const { center, radiusM } = body.focus;
            const reach = chosen.filter(
                (e) => distanceM(e.location, center) <= e.connectivityRadiusM + radiusM,
            );
            if (reach.length) chosen = reach;
        }
        if (!chosen.length)
            throw new HttpError(409, `zone ${zone.id}: no edge servers to scan with`);

        const scan: Scan = {
            runId: crypto.randomUUID(),
            zoneId: zone.id,
            purpose: body.purpose,
            state: 'mapping',
            focus: body.focus ?? null,
            reason: body.reason,
            requestedBy: body.requestedBy,
            edgeServerIds: chosen.map((e) => e.edgeServerId),
            results: [],
            error: null,
            startedAt: iso(deps.now()),
            stoppedAt: null,
        };
        try {
            const result = await deps.edge.send({
                kind: 'start_mapping',
                runId: scan.runId,
                zoneId: zone.id,
                boundary: body.focus
                    ? circle(body.focus.center, body.focus.radiusM)
                    : zone.boundary,
                cellSizeM: deps.config.scanCellSizeM,
                altitude: ALTITUDE,
                edgeServers: chosen.map((e) => ({
                    edgeServerId: e.edgeServerId,
                    url: e.url,
                    location: e.location,
                    connectivityRadiusM: e.connectivityRadiusM,
                })),
            });
            scan.results = result.results;
            if (!result.results.some((r) => r.ok)) {
                scan.state = 'failed';
                scan.error = 'no edge server started the run';
            }
        } catch (err) {
            scan.state = 'failed';
            scan.error = err instanceof Error ? err.message : String(err);
        }
        await store.scans.insert(scan);
        return reply.code(201).send(scan);
    });

    app.post<{ Params: { runId: string } }>(SCAN_STOP_PATH, staff, async (req) => {
        const scan = await store.scans.get(req.params.runId);
        if (!scan) throw notFound(`scan ${req.params.runId}`);
        parse(s.stopScan, req.body);
        if (scan.state !== 'mapping') return scan;
        const servers = await store.edgeServers.list({ zoneId: scan.zoneId });
        try {
            const result = await deps.edge.send({
                kind: 'stop_mapping',
                runId: scan.runId,
                zoneId: scan.zoneId,
                edgeServers: servers
                    .filter((e) => scan.edgeServerIds.includes(e.edgeServerId))
                    .map((e) => ({ edgeServerId: e.edgeServerId, url: e.url })),
            });
            scan.results = result.results;
        } catch (err) {
            scan.error = err instanceof Error ? err.message : String(err);
        }
        scan.state = 'stopped';
        scan.stoppedAt = iso(deps.now());
        await store.scans.put(scan);
        return scan;
    });
}
