import type { FastifyInstance } from 'fastify';
import { DETECTIONS_PATH } from '@ember/contracts';
import type {
    CameraSpec,
    DetectionFrame,
    DetectionsIngest,
    DetectionsIngestResult,
    DroneDetections,
    DronePose,
    LatLng,
    RiskDetection,
    RiskLevel,
    WatchZoneId,
} from '@ember/contracts';
import type {
    Detection as DetectionRow,
    DetectionFrame as DetectionFrameRow,
    Prisma,
} from '../generated/prisma/client.js';
import { isDbError, type Db } from '../db.js';
import { notFound, orMissing } from '../http.js';
import { dateTime, deviceId, droneDetections, limit, uuid } from '../schemas.js';

const params = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const one = `${DETECTIONS_PATH}/:id`;
const withDetections = { detections: { orderBy: { detectionId: 'asc' } } } as const;

type Risk = Exclude<RiskLevel, 'none'>;
type FrameQuery = {
    zoneId?: string;
    droneId?: string;
    edgeServerId?: string;
    risk?: Risk;
    since?: string;
    limit: number;
};

export function riskDetectionWire(row: DetectionRow): RiskDetection {
    const detection: RiskDetection = {
        id: row.detectionId,
        risk: row.risk,
        confidence: row.confidence,
        bboxPx: row.bboxPx as RiskDetection['bboxPx'],
        ground: row.ground as LatLng[],
        center: { lat: row.centerLat, lng: row.centerLng },
        areaM2: row.areaM2,
    };
    if (row.peakTempK !== null) detection.peakTempK = row.peakTempK;
    return detection;
}

export function detectionFrameWire(
    row: DetectionFrameRow & { detections: DetectionRow[] },
): DetectionFrame {
    return {
        type: 'detections',
        id: row.id,
        droneId: row.droneId,
        frameId: row.frameId,
        capturedAt: row.capturedAt.toISOString(),
        scenarioTime: row.scenarioTime,
        pose: row.pose as DronePose,
        camera: row.camera as CameraSpec,
        detector: row.detector,
        detections: row.detections.map(riskDetectionWire),
        zoneId: row.zoneId as WatchZoneId | null,
        edgeServerId: row.edgeServerId,
        receivedAt: row.receivedAt.toISOString(),
    };
}

type Placement = { zoneId: string | null; edgeServerId: string | null };

/** Which zone and edge server each drone's frames belong to, as registered right now. */
async function placements(
    db: Db,
    ingest: DetectionsIngest,
): Promise<(droneId: string) => Placement> {
    if (ingest.edgeServerId !== undefined) {
        const edge = await db.edgeServer.findUnique({
            where: { id: ingest.edgeServerId },
            select: { zoneId: true },
        });
        const placement = { zoneId: edge?.zoneId ?? null, edgeServerId: ingest.edgeServerId };
        return () => placement;
    }
    const drones = await db.drone.findMany({
        where: { id: { in: [...new Set(ingest.frames.map((f) => f.droneId))] } },
        select: { id: true, edgeServerId: true, edgeServer: { select: { zoneId: true } } },
    });
    const byId = new Map(
        drones.map((d) => [
            d.id,
            { zoneId: d.edgeServer?.zoneId ?? null, edgeServerId: d.edgeServerId },
        ]),
    );
    return (droneId) => byId.get(droneId) ?? { zoneId: null, edgeServerId: null };
}

/** False when the frame is already stored. */
async function storeFrame(db: Db, frame: DroneDetections, placement: Placement): Promise<boolean> {
    try {
        await db.detectionFrame.create({
            data: {
                ...placement,
                droneId: frame.droneId,
                frameId: frame.frameId,
                capturedAt: new Date(frame.capturedAt),
                scenarioTime: frame.scenarioTime,
                pose: frame.pose,
                camera: frame.camera,
                detector: frame.detector,
                detections: {
                    create: frame.detections.map((d) => ({
                        detectionId: d.id,
                        risk: d.risk,
                        confidence: d.confidence,
                        bboxPx: d.bboxPx,
                        ground: d.ground,
                        centerLat: d.center.lat,
                        centerLng: d.center.lng,
                        areaM2: d.areaM2,
                        peakTempK: d.peakTempK ?? null,
                    })),
                },
            },
        });
        return true;
    } catch (err) {
        if (isDbError(err, 'P2002')) return false;
        throw err;
    }
}

export function detectionRoutes(app: FastifyInstance, db: Db) {
    app.post<{ Body: DetectionsIngest }>(
        DETECTIONS_PATH,
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['frames'],
                    additionalProperties: false,
                    properties: {
                        edgeServerId: deviceId,
                        frames: { type: 'array', maxItems: 2000, items: droneDetections },
                    },
                },
            },
        },
        async (req, reply) => {
            const placeOf = await placements(db, req.body);
            const stored = await Promise.all(
                req.body.frames.map((frame) => storeFrame(db, frame, placeOf(frame.droneId))),
            );
            const accepted = stored.filter(Boolean).length;
            const result: DetectionsIngestResult = {
                accepted,
                duplicates: stored.length - accepted,
            };
            return reply.send(result);
        },
    );

    app.get<{ Querystring: FrameQuery }>(
        DETECTIONS_PATH,
        {
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        zoneId: uuid,
                        droneId: deviceId,
                        edgeServerId: deviceId,
                        risk: { enum: ['at_risk', 'on_fire'] },
                        since: dateTime,
                        limit,
                    },
                },
            },
        },
        async (req, reply) => {
            const { zoneId, droneId, edgeServerId, risk, since } = req.query;
            const where: Prisma.DetectionFrameWhereInput = {};
            if (zoneId !== undefined) where.zoneId = zoneId;
            if (droneId !== undefined) where.droneId = droneId;
            if (edgeServerId !== undefined) where.edgeServerId = edgeServerId;
            if (since !== undefined) where.capturedAt = { gte: new Date(since) };
            if (risk !== undefined) where.detections = { some: { risk } };
            const rows = await db.detectionFrame.findMany({
                where,
                orderBy: { capturedAt: 'desc' },
                take: req.query.limit,
                include: {
                    detections: {
                        where: risk === undefined ? {} : { risk },
                        orderBy: { detectionId: 'asc' },
                    },
                },
            });
            return reply.send(rows.map(detectionFrameWire));
        },
    );

    app.get<{ Params: { id: string } }>(one, { schema: { params } }, async (req, reply) => {
        const row = await db.detectionFrame.findUnique({
            where: { id: req.params.id },
            include: withDetections,
        });
        return row ? detectionFrameWire(row) : notFound(reply, `detections frame ${req.params.id}`);
    });

    app.delete<{ Params: { id: string } }>(one, { schema: { params } }, async (req, reply) => {
        const row = await orMissing(db.detectionFrame.delete({ where: { id: req.params.id } }));
        return row ? reply.code(204).send() : notFound(reply, `detections frame ${req.params.id}`);
    });
}
