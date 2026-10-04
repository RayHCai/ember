import type { FastifyInstance } from 'fastify';
import {
    INCIDENT_EVENTS_PATH,
    INCIDENT_PATH,
    REPORT_PATH,
    ZONE_INCIDENTS_PATH,
    ZONE_REPORTS_PATH,
    type FieldReport,
    type Incident,
    type IncidentEvent,
    type IncidentView,
    type WatchZoneId,
} from '@ember/contracts';
import { z } from 'zod';
import { guard, STAFF } from '../auth.js';
import { iso, requireZone, type Deps } from '../deps.js';
import { notFound, parse } from '../errors.js';
import * as s from '../schemas.js';

const reportQuery = z.object({ unprocessed: z.enum(['true', 'false']).optional() });

export function incidentRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    async function requireIncident(id: string): Promise<Incident> {
        const incident = await store.incidents.get(id);
        if (!incident) throw notFound(`incident ${id}`);
        return incident;
    }

    app.get<{ Params: { zoneId: string } }>(ZONE_INCIDENTS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        return store.incidents.list(
            { zoneId: req.params.zoneId as WatchZoneId },
            { orderBy: 'number', desc: true },
        );
    });

    app.post<{ Params: { zoneId: string } }>(ZONE_INCIDENTS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.createIncident, req.body);
        const now = iso(deps.now());
        const incident: Incident = {
            id: crypto.randomUUID(),
            number: await store.counters.next('incident'),
            zoneId: zone.id,
            ...body,
            latestJobId: null,
            previousJobId: null,
            openedAt: now,
            updatedAt: now,
        };
        await store.incidents.insert(incident);
        return reply.code(201).send(incident);
    });

    app.get<{ Params: { incidentId: string } }>(INCIDENT_PATH, staff, async (req) => {
        const incident = await requireIncident(req.params.incidentId);
        const events = await store.incidentEvents.list(
            { incidentId: incident.id },
            { orderBy: 'at' },
        );
        const out: IncidentView = { incident, events };
        return out;
    });

    app.patch<{ Params: { incidentId: string } }>(INCIDENT_PATH, staff, async (req) => {
        const incident = await requireIncident(req.params.incidentId);
        const body = parse(s.updateIncident, req.body);
        const before = incident.state;
        Object.assign(incident, body, { updatedAt: iso(deps.now()) });
        await store.incidents.put(incident);
        if (body.state && body.state !== before) {
            await store.incidentEvents.insert({
                id: crypto.randomUUID(),
                incidentId: incident.id,
                kind: 'state',
                summary: `${before} → ${body.state}`,
                refs: {},
                actor: 'api',
                at: incident.updatedAt,
            });
        }
        return incident;
    });

    app.post<{ Params: { incidentId: string } }>(
        INCIDENT_EVENTS_PATH,
        staff,
        async (req, reply) => {
            const incident = await requireIncident(req.params.incidentId);
            const body = parse(s.incidentEvent, req.body);
            const event: IncidentEvent = {
                id: crypto.randomUUID(),
                incidentId: incident.id,
                ...body,
                at: iso(deps.now()),
            };
            await store.incidentEvents.insert(event);
            return reply.code(201).send(event);
        },
    );

    app.get<{ Params: { zoneId: string } }>(ZONE_REPORTS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        const q = parse(reportQuery, req.query, 'query');
        return store.reports.list(
            {
                zoneId: req.params.zoneId as WatchZoneId,
                ...(q.unprocessed === 'true' ? { processedAt: null } : {}),
            },
            { orderBy: 'receivedAt' },
        );
    });

    app.post<{ Params: { zoneId: string } }>(ZONE_REPORTS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.createReport, req.body);
        const report: FieldReport = {
            id: crypto.randomUUID(),
            zoneId: zone.id,
            ...body,
            receivedAt: iso(deps.now()),
            processedAt: null,
            processedNote: null,
        };
        await store.reports.insert(report);
        return reply.code(201).send(report);
    });

    app.patch<{ Params: { reportId: string } }>(REPORT_PATH, staff, async (req) => {
        const report = await store.reports.get(req.params.reportId);
        if (!report) throw notFound(`report ${req.params.reportId}`);
        const body = parse(s.processReport, req.body);
        report.processedAt = iso(deps.now());
        report.processedNote = body.note;
        await store.reports.put(report);
        return report;
    });
}
