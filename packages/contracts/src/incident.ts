import type { LatLng, WatchZoneId } from './common.js';
import type { ImpactSeverity, PlannerJobState, PlannerOptions, PlannerResult } from './planner.js';

/**
 * Incident plane: incidents, planner jobs as the dashboard and operator-agent see them, approvals
 * and free-text field reports. Paths use Fastify parameter syntax.
 */
export const ZONE_INCIDENTS_PATH = '/v1/watch-zones/:zoneId/incidents';
export const INCIDENT_PATH = '/v1/incidents/:incidentId';
export const INCIDENT_EVENTS_PATH = '/v1/incidents/:incidentId/events';
export const ZONE_PLANNER_JOBS_PATH = '/v1/watch-zones/:zoneId/planner-jobs';
export const ZONE_LATEST_PLAN_PATH = '/v1/watch-zones/:zoneId/planner-jobs/latest';
export const PLANNER_JOB_PATH = '/v1/planner/jobs/:jobId';
export const APPROVALS_PATH = '/v1/approvals';
export const APPROVAL_PATH = '/v1/approvals/:approvalId';
export const APPROVAL_DECISION_PATH = '/v1/approvals/:approvalId/decision';
export const ZONE_REPORTS_PATH = '/v1/watch-zones/:zoneId/reports';
export const REPORT_PATH = '/v1/reports/:reportId';

/** Which part of Ember is acting: watching and preventing, fighting a fire, or protecting people. */
export type OperationalDomain = 'prevention' | 'emergency' | 'civilian';

export type IncidentState = 'suspected' | 'verifying' | 'active' | 'contained' | 'closed';

export type Incident = {
    id: string;
    /** Sequential across Ember: "Incident #14". */
    number: number;
    zoneId: WatchZoneId;
    state: IncidentState;
    domain: OperationalDomain;
    title: string;
    summary: string;
    location: LatLng | null;
    detectionIds: string[];
    /** The newest succeeded plan for this incident, and the one before it. */
    latestJobId: string | null;
    previousJobId: string | null;
    openedAt: string;
    updatedAt: string;
};

export type CreateIncidentRequest = Pick<
    Incident,
    'state' | 'domain' | 'title' | 'summary' | 'location' | 'detectionIds'
>;

export type UpdateIncidentRequest = Partial<
    Pick<Incident, 'state' | 'domain' | 'title' | 'summary' | 'location' | 'detectionIds'>
>;

export type IncidentEventKind =
    | 'detection'
    | 'verification'
    | 'plan'
    | 'assignment'
    | 'road'
    | 'alert'
    | 'message'
    | 'state'
    | 'note';

/** The incident's timeline, as the operator reads it. */
export type IncidentEvent = {
    id: string;
    incidentId: string;
    kind: IncidentEventKind;
    summary: string;
    /** Ids this event is about, e.g. `{ jobId, roadObservationId }`. */
    refs: Record<string, string>;
    actor: string;
    at: string;
};

export type CreateIncidentEventRequest = Pick<IncidentEvent, 'kind' | 'summary' | 'refs' | 'actor'>;

export type IncidentView = { incident: Incident; events: IncidentEvent[] };

/** A planner job as api records it. */
export type PlannerJob = {
    jobId: string;
    zoneId: WatchZoneId;
    state: PlannerJobState;
    requestedBy: string;
    requestedAt: string;
    updatedAt: string;
    /** The orchestrator's latest note, or the error when `failed`. */
    message: string | null;
    options: PlannerOptions;
    reason: string | null;
    incidentId: string | null;
};

/** api LPUSHes the `PlannerJobRequest` and answers 202 with the queued `PlannerJob`. */
export type EnqueuePlannerJobRequest = {
    requestedBy: string;
    reason?: string;
    incidentId?: string;
    options?: PlannerOptions;
};

export type PlannerJobView = { job: PlannerJob; result: PlannerResult | null };

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'sent';

/** One personalised text per civilian of one area, all from the same plan. */
export type CivilianAlertDraft = {
    kind: 'civilian_alert';
    jobId: string;
    civilianAreaId: string;
    severity: ImpactSeverity;
    recipients: { civilianId: string; body: string }[];
    mapUrl: string | null;
};

export type AuthorityAudience = 'fire_department' | 'utility' | 'emergency_management' | 'police';

/** Ember never contacts authorities itself: an approved notification is handed to the operator. */
export type AuthorityNotificationDraft = {
    kind: 'authority_notification';
    audience: AuthorityAudience;
    organization: string;
    subject: string;
    body: string;
};

export type ApprovalDraft = CivilianAlertDraft | AuthorityNotificationDraft;

/**
 * The operator approval record every outbound civilian alert needs. `confirmationCode` is shown
 * with the draft and must be sent back with the decision, so a decision names what it approves.
 */
export type Approval = {
    id: string;
    /** Sequential across Ember: "approve 7 K3QF". */
    number: number;
    zoneId: WatchZoneId;
    incidentId: string | null;
    state: ApprovalState;
    draft: ApprovalDraft;
    reason: string;
    draftedBy: string;
    confirmationCode: string;
    createdAt: string;
    decidedBy: string | null;
    decidedVia: 'dashboard' | 'asi1' | null;
    decidedAt: string | null;
    decisionNote: string | null;
};

export type CreateApprovalRequest = Pick<Approval, 'zoneId' | 'draft' | 'reason' | 'draftedBy'> & {
    incidentId?: string;
};

/** Needs the operator key. 409 when the approval is no longer pending or the code differs. */
export type ApprovalDecisionRequest = {
    decision: 'approve' | 'reject';
    operator: string;
    via: 'dashboard' | 'asi1';
    confirmationCode: string;
    note?: string;
};

export type FieldReportSource = 'responder' | 'civilian' | 'operator';

/** Free text from the field. operator-agent turns each into structured observations. */
export type FieldReport = {
    id: string;
    zoneId: WatchZoneId;
    source: FieldReportSource;
    /** `responder:<id>`, `civilian:<id>`, or an operator name. */
    reporterId: string;
    text: string;
    location: LatLng | null;
    photoUrl: string | null;
    receivedAt: string;
    /** Set once operator-agent has acted on it. */
    processedAt: string | null;
    processedNote: string | null;
};

export type CreateFieldReportRequest = Pick<
    FieldReport,
    'source' | 'reporterId' | 'text' | 'location' | 'photoUrl'
>;

export type ProcessFieldReportRequest = { note: string };
