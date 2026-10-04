import type { LatLng, WatchZoneId } from './common.js';

export const CIVILIANS_PATH = '/civilians';
export const CIVILIAN_PATH = '/v1/civilians/:civilianId';
export const ZONE_CIVILIANS_PATH = '/v1/watch-zones/:zoneId/civilians';
export const CIVILIAN_MESSAGES_PATH = '/v1/civilian-messages';
export const CIVILIAN_MESSAGE_PATH = '/v1/civilian-messages/:messageId';
export const CIVILIAN_INBOUND_PATH = '/v1/civilian-messages/inbound';

export type Civilian = {
    id: string;
    /** Sequential across Ember: "Civilian 4". */
    number: number;
    /** Lowercased. The iMessage handle when there is no phone. */
    email: string;
    /** E.164, e.g. `+18085550123`. Texts go here when set. */
    phone: string | null;
    /** US 5-digit ZIP. */
    zipCode: string;
    /** The planner `CivilianArea` they live in, once known. */
    civilianAreaId: string | null;
    zoneId: WatchZoneId | null;
    location: LatLng | null;
    /** Household notes they shared: pets, mobility, people at home. */
    notes: string | null;
    createdAt: string;
};

export type CreateCivilianRequest = Pick<Civilian, 'email' | 'zipCode'>;

export type UpdateCivilianRequest = Partial<
    Pick<Civilian, 'civilianAreaId' | 'location' | 'notes' | 'phone'>
>;

export type CivilianChannel = 'imessage' | 'sms' | 'asi1';

export type CivilianMessageStatus = 'received' | 'queued' | 'sent' | 'failed';

export type CivilianMessage = {
    id: string;
    civilianId: string;
    direction: 'inbound' | 'outbound';
    channel: CivilianChannel;
    body: string;
    attachments: { url: string; mimeType: string }[];
    /** Outbound alerts: the approval that allowed it. */
    approvalId: string | null;
    /** Outbound replies: the inbound message of the conversation the civilian started. */
    inReplyTo: string | null;
    jobId: string | null;
    status: CivilianMessageStatus;
    error: string | null;
    createdAt: string;
    sentAt: string | null;
};

/** A transport -> api. `handle` is the email or phone the civilian wrote from; phones match in E.164. */
export type InboundCivilianMessageRequest = {
    handle: string;
    channel: CivilianChannel;
    body: string;
    attachments: { url: string; mimeType: string }[];
};

/** 404 when the handle is not a registered civilian; the reply asks them to sign up. */
export type InboundCivilianMessageResult = { civilian: Civilian; message: CivilianMessage };

/**
 * Queues an outbound message. The api answers 403 unless `approvalId` names an approved civilian
 * alert listing this civilian with exactly this body, or `inReplyTo` names an inbound message from
 * this civilian received within the last 24 hours.
 */
export type QueueCivilianMessageRequest = {
    civilianId: string;
    channel: CivilianChannel;
    body: string;
    approvalId?: string;
    inReplyTo?: string;
    jobId?: string;
};

/** The transport reports delivery. */
export type CivilianMessageDeliveryRequest = { status: 'sent' | 'failed'; error?: string };
