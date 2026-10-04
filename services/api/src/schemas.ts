// JSON schema fragments for the contracts' shapes, checked by Fastify at each route.

export const uuid = { type: 'string', format: 'uuid' } as const;

/** Edge server tokens and drone ids: chosen by the device, not the api. */
export const deviceId = { type: 'string', minLength: 1, maxLength: 200 } as const;

export const dateTime = { type: 'string', format: 'date-time' } as const;

export const latLng = {
    type: 'object',
    required: ['lat', 'lng'],
    additionalProperties: false,
    properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
    },
} as const;

export const ring = { type: 'array', minItems: 3, maxItems: 10_000, items: latLng } as const;

export const pose = {
    type: 'object',
    required: ['lat', 'lng', 'altM', 'headingDeg', 'pitchDeg'],
    additionalProperties: false,
    properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
        altM: { type: 'number' },
        headingDeg: { type: 'number' },
        pitchDeg: { type: 'number' },
    },
} as const;

export const camera = {
    type: 'object',
    required: ['widthPx', 'heightPx', 'hfovDeg'],
    additionalProperties: false,
    properties: {
        widthPx: { type: 'number', exclusiveMinimum: 0 },
        heightPx: { type: 'number', exclusiveMinimum: 0 },
        hfovDeg: { type: 'number', exclusiveMinimum: 0 },
    },
} as const;

export const riskDetection = {
    type: 'object',
    required: ['id', 'risk', 'confidence', 'bboxPx', 'ground', 'center', 'areaM2'],
    additionalProperties: false,
    properties: {
        id: { type: 'string', minLength: 1, maxLength: 200 },
        risk: { enum: ['at_risk', 'on_fire'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        bboxPx: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
        ground: { type: 'array', maxItems: 10_000, items: latLng },
        center: latLng,
        areaM2: { type: 'number', minimum: 0 },
        peakTempK: { type: 'number' },
    },
} as const;

export const droneDetections = {
    type: 'object',
    required: [
        'type',
        'droneId',
        'frameId',
        'capturedAt',
        'scenarioTime',
        'pose',
        'camera',
        'detector',
        'detections',
    ],
    additionalProperties: false,
    properties: {
        type: { const: 'detections' },
        droneId: deviceId,
        frameId: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
        capturedAt: dateTime,
        scenarioTime: dateTime,
        pose,
        camera,
        detector: { type: 'string', minLength: 1, maxLength: 200 },
        detections: { type: 'array', maxItems: 1000, items: riskDetection },
    },
} as const;

export const plannerOptions = {
    type: 'object',
    additionalProperties: false,
    properties: {
        horizonMin: { type: 'number', exclusiveMinimum: 0 },
        bandMin: { type: 'number', exclusiveMinimum: 0 },
        attackZoneCount: { type: 'integer', minimum: 0 },
        evacuationDelayMin: { type: 'number', minimum: 0 },
        safetyMarginMin: { type: 'number', minimum: 0 },
    },
} as const;

export const nullable = <S extends object>(schema: S) =>
    ({ anyOf: [{ type: 'null' }, schema] }) as const;

/** Every list takes `limit`; most recent first. */
export const limit = { type: 'integer', minimum: 1, maximum: 1000, default: 100 } as const;
