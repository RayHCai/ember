import type { FastifyInstance } from 'fastify';
import { FOREST_FIT_PATH, ZONE_SURROUNDINGS_PATH, ZONE_WEATHER_PATH } from '@ember/contracts';
import type { ForestFitRequest, LatLng, ZoneWeather } from '@ember/contracts';
import type { Db } from '../db.js';
import { centroid } from '../geo.js';
import { notFound } from '../http.js';
import { OpenDataError, type OpenData } from '../openData/types.js';
import { ring, uuid } from '../schemas.js';
import { surroundingsWire, type Surroundings } from '../surroundings.js';

const zoneParams = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;

type ZoneParams = { zoneId: string };

/** What the api reads from open map and weather data for a zone, and the forest fit. */
export function surroundingsRoutes(
    app: FastifyInstance,
    {
        db,
        openData,
        surroundings,
    }: { db: Db; openData: OpenData | null; surroundings: Surroundings },
) {
    const zoneOf = (zoneId: string) =>
        db.watchZone.findUnique({ where: { id: zoneId }, select: { id: true, boundary: true } });

    app.get<{ Params: ZoneParams; Querystring: { roads: boolean } }>(
        ZONE_SURROUNDINGS_PATH,
        {
            schema: {
                params: zoneParams,
                querystring: {
                    type: 'object',
                    properties: { roads: { type: 'boolean', default: true } },
                },
            },
        },
        async (req, reply) => {
            const zone = await zoneOf(req.params.zoneId);
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            const row =
                (await db.zoneSurroundings.findUnique({ where: { zoneId: zone.id } })) ??
                (await surroundings.refresh(zone.id, zone.boundary as LatLng[]));
            return surroundingsWire(row, req.query.roads);
        },
    );

    app.post<{ Params: ZoneParams }>(
        `${ZONE_SURROUNDINGS_PATH}/refresh`,
        { schema: { params: zoneParams } },
        async (req, reply) => {
            const zone = await zoneOf(req.params.zoneId);
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            const row = await surroundings.refresh(zone.id, zone.boundary as LatLng[]);
            return reply.code(202).send(surroundingsWire(row));
        },
    );

    app.get<{ Params: ZoneParams }>(
        ZONE_WEATHER_PATH,
        { schema: { params: zoneParams } },
        async (req, reply) => {
            const zone = await zoneOf(req.params.zoneId);
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            const body: ZoneWeather = {
                weather: openData
                    ? await openData.weather(centroid(zone.boundary as LatLng[]))
                    : null,
            };
            return body;
        },
    );

    app.post<{ Body: ForestFitRequest }>(
        FOREST_FIT_PATH,
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['boundary'],
                    additionalProperties: false,
                    properties: { boundary: ring },
                },
            },
        },
        async (req, reply) => {
            if (!openData) return reply.code(503).send({ error: 'open data is off' });
            try {
                const fit = await openData.fitForest(req.body.boundary);
                return (
                    fit ??
                    reply.code(404).send({ error: 'no vegetation found inside that outline' })
                );
            } catch (err) {
                if (err instanceof OpenDataError) {
                    return reply.code(502).send({ error: `forest fit: ${err.message}` });
                }
                throw err;
            }
        },
    );
}
