import { z } from 'zod';

export const latLng = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});
export const ring = z.array(latLng).min(3).max(5000);
const id = z.string().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);

export const createWatchZone = z
    .object({
        name: text(120),
        boundary: ring.optional(),
        center: latLng.optional(),
        radiusM: z.number().positive().max(50_000).optional(),
    })
    .refine((v) => v.boundary || (v.center && v.radiusM), {
        message: 'give a boundary, or a center and radiusM',
    });

const roadKind = z.enum(['motorway', 'primary', 'secondary', 'residential', 'track']);
export const roadState = z.enum(['open', 'blocked', 'uncertain']);
const fuel = z.enum(['none', 'grass', 'shrub', 'timber', 'urban']);

export const geography = z.object({
    terrain: z
        .object({
            southWest: latLng,
            cellSizeM: z.number().positive(),
            cols: z.number().int().positive(),
            rows: z.number().int().positive(),
            elevationM: z.array(z.number().nullable()).nullable(),
            fuel: z.array(fuel).nullable(),
        })
        .nullable(),
    roads: z
        .array(
            z.object({
                id,
                name: z.string().max(200).nullable(),
                kind: roadKind,
                path: z.array(latLng).min(2),
                state: roadState.optional(),
            }),
        )
        .max(20_000),
    civilianAreas: z.array(
        z.object({
            id,
            name: text(200),
            center: latLng,
            polygon: ring.nullable(),
            population: z.number().min(0),
        }),
    ),
    safeZones: z.array(
        z.object({ id, name: text(200), location: latLng, capacity: z.number().min(0).nullable() }),
    ),
    stations: z.array(z.object({ id, name: text(200), location: latLng })),
});

export const surveillance = z.object({
    intervalMin: z
        .number()
        .positive()
        .max(24 * 60)
        .nullable(),
    priorities: z.array(z.string().max(200)).max(50),
    reason: text(2000),
    setBy: text(200),
});

export const roadObservation = z
    .object({
        roadId: id.optional(),
        roadName: text(200).optional(),
        state: roadState,
        source: z.enum(['responder', 'civilian', 'operator', 'drone']),
        reportedBy: text(200),
        note: z.string().max(2000).nullable(),
        location: latLng.nullable(),
    })
    .refine((v) => v.roadId || v.roadName, { message: 'give roadId or roadName' });

const risk = z.enum(['at_risk', 'on_fire']);

const detection = z.object({
    id,
    risk,
    confidence: z.number().min(0).max(1),
    bboxPx: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    ground: z.array(latLng),
    center: latLng,
    areaM2: z.number().min(0),
    peakTempK: z.number().optional(),
});

export const detectionsFrame = z.object({
    type: z.literal('detections'),
    droneId: id,
    frameId: z.number(),
    capturedAt: z.string(),
    scenarioTime: z.string(),
    detector: z.string(),
    detections: z.array(detection).max(500),
});

export const simulatedDetection = z.object({
    center: latLng,
    radiusM: z.number().positive().max(5_000),
    risk,
    confidence: z.number().min(0).max(1),
    requestedBy: text(200),
});

export const detectionVerification = z.object({
    verification: z.enum(['unverified', 'verifying', 'confirmed', 'dismissed']),
    by: text(200),
});

export const createRiskZone = z.object({
    risk,
    polygon: ring,
    confidence: z.number().min(0).max(1),
    observedAt: z.iso.datetime({ offset: true }),
});

export const registerEdgeServer = z.object({
    edgeServerId: id,
    url: z.url(),
    name: text(200),
    location: latLng,
    connectivityRadiusM: z.number().positive().max(50_000),
});

const focus = z.object({ center: latLng, radiusM: z.number().positive().max(20_000) });

export const startScan = z.object({
    purpose: z.enum(['surveillance', 'verification']),
    reason: text(2000),
    requestedBy: text(200),
    focus: focus.optional(),
    edgeServerIds: z.array(id).max(100).optional(),
});

export const stopScan = z.object({ requestedBy: text(200), reason: text(2000) });

export const plannerOptions = z
    .object({
        horizonMin: z.number().positive().max(1440),
        bandMin: z.number().positive(),
        attackZoneCount: z.number().int().min(0).max(50),
        evacuationDelayMin: z.number().min(0),
        safetyMarginMin: z.number().min(0),
        sectorSizeM: z.number().positive(),
    })
    .partial();

export const enqueuePlannerJob = z.object({
    requestedBy: text(200),
    reason: z.string().max(2000).optional(),
    incidentId: id.optional(),
    options: plannerOptions.optional(),
});

export const plannerStatus = z.object({
    jobId: id,
    zoneId: id,
    state: z.enum(['gathering', 'planning', 'failed']),
    at: z.string(),
    message: z.string().nullable(),
});

/** The planner is trusted for content; the api checks only what it files the result under. */
export const plannerResult = z
    .object({
        jobId: id,
        zoneId: id,
        generatedAt: z.string(),
        attackZones: z.array(z.object({ id }).loose()),
        civilianImpacts: z.array(z.object({ civilianAreaId: id }).loose()),
        evacuationRoutes: z.array(z.object({ civilianAreaId: id }).loose()),
    })
    .loose();

const domain = z.enum(['prevention', 'emergency', 'civilian']);
const incidentState = z.enum(['suspected', 'verifying', 'active', 'contained', 'closed']);

export const createIncident = z.object({
    state: incidentState,
    domain,
    title: text(200),
    summary: z.string().max(4000),
    location: latLng.nullable(),
    detectionIds: z.array(id).max(500),
});

export const updateIncident = createIncident.partial();

export const incidentEvent = z.object({
    kind: z.enum([
        'detection',
        'verification',
        'plan',
        'assignment',
        'road',
        'alert',
        'message',
        'state',
        'note',
    ]),
    summary: text(4000),
    refs: z.record(z.string(), z.string()),
    actor: text(200),
});

const civilianAlert = z.object({
    kind: z.literal('civilian_alert'),
    jobId: id,
    civilianAreaId: id,
    severity: z.enum(['immediate', 'warning', 'watch', 'clear']),
    recipients: z
        .array(z.object({ civilianId: id, body: text(1600) }))
        .min(1)
        .max(5000),
    mapUrl: z.string().max(2000).nullable(),
});

const authorityNotification = z.object({
    kind: z.literal('authority_notification'),
    audience: z.enum(['fire_department', 'utility', 'emergency_management', 'police']),
    organization: text(200),
    subject: text(300),
    body: text(4000),
});

export const createApproval = z.object({
    zoneId: id,
    incidentId: id.optional(),
    draft: z.discriminatedUnion('kind', [civilianAlert, authorityNotification]),
    reason: text(4000),
    draftedBy: text(200),
});

export const approvalDecision = z.object({
    decision: z.enum(['approve', 'reject']),
    operator: text(200),
    via: z.enum(['dashboard', 'asi1']),
    confirmationCode: text(20),
    note: z.string().max(2000).optional(),
});

export const createReport = z.object({
    source: z.enum(['responder', 'civilian', 'operator']),
    reporterId: text(200),
    text: text(4000),
    location: latLng.nullable(),
    photoUrl: z.string().max(2000).nullable(),
});

export const processReport = z.object({ note: text(2000) });

export const phone = z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'a phone number in E.164, e.g. +18085550123');

export const updateCivilian = z.object({
    phone: phone.nullable().optional(),
    civilianAreaId: id.nullable().optional(),
    location: latLng.nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
});

const channel = z.enum(['imessage', 'sms', 'asi1']);
const attachments = z
    .array(z.object({ url: z.string().max(2000), mimeType: z.string().max(100) }))
    .max(10);

export const inboundCivilianMessage = z.object({
    handle: text(254),
    channel,
    body: z.string().max(4000),
    attachments,
});

export const queueCivilianMessage = z.object({
    civilianId: id,
    channel,
    body: text(1600),
    approvalId: id.optional(),
    inReplyTo: id.optional(),
    jobId: id.optional(),
});

export const civilianDelivery = z.object({
    status: z.enum(['sent', 'failed']),
    error: z.string().max(2000).optional(),
});

export const createResponder = z.object({
    name: text(200),
    role: text(100),
    capabilities: z.array(z.string().max(100)).max(50),
    stationId: id.nullable(),
    location: latLng.nullable(),
});

export const updateResponder = z.object({
    location: latLng.nullable().optional(),
    availability: z.enum(['available', 'assigned', 'unavailable']).optional(),
    status: z.enum(['idle', 'en_route', 'on_scene', 'returning', 'off_duty']).optional(),
});

export const assignResponders = z.object({
    jobId: id,
    incidentId: id.optional(),
    attackZoneIds: z.array(id).max(50).optional(),
    perZone: z.number().int().min(1).max(10).optional(),
});

export const responderMessage = z.object({
    responderId: id.nullable(),
    kind: z.enum(['incident', 'update', 'plan', 'directive', 'all_clear']),
    priority: z.enum(['routine', 'urgent', 'critical']),
    title: text(200),
    body: text(4000),
    from: text(200),
    location: latLng.nullable(),
});

export const pairingCode = z.object({ responderId: id.optional() });

export const pair = z.object({
    token: text(200),
    deviceName: text(200),
    platform: z.enum(['ios', 'android', 'web']),
});

export const since = z.object({ since: z.iso.datetime({ offset: true }).optional() });
