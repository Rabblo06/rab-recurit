/**
 * Response contracts of the main client-facing endpoints: what the Staff app (packages/rab-mobile, lib/core/models and
 * the feature providers) parses from each response. A field the app casts without a null check is `required`; a field
 * it reads as optional is listed but not required, and `nullable` where the app accepts null. Extra fields are allowed
 * (the server may add, never remove or retype).
 *
 * Merged into the generated OpenAPI document (build-openapi-document.ts) and proved against live responses by
 * openapi-contract.integration.spec.ts. Installed apps lag behind the server, so changing one of these is a breaking
 * API change for every app version in the field: change the schema here, the app and the server together.
 */

type Schema = Record<string, unknown>;

const uuid: Schema = { type: 'string', format: 'uuid' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const nullableDateTime: Schema = { type: 'string', format: 'date-time', nullable: true };
const nullableString: Schema = { type: 'string', nullable: true };
const date: Schema = { type: 'string', format: 'date' };
const pence: Schema = { type: 'integer', minimum: 0 };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const page = (item: string): Schema => ({
  type: 'object',
  required: ['data'],
  properties: { data: { type: 'array', items: ref(item) }, nextCursor: nullableString },
});

export const CONTRACT_COMPONENTS: Readonly<Record<string, Schema>> = {
  ContractLoginResponse: {
    type: 'object',
    description: 'A completed password sign-in. A mobile client (X-Client-Platform: mobile) also receives its refresh token here.',
    required: ['accessToken'],
    properties: { accessToken: { type: 'string', minLength: 1 }, refreshToken: { type: 'string', minLength: 1 } },
  },
  ContractCurrentUser: {
    type: 'object',
    required: ['id', 'email', 'firstName', 'lastName', 'organisationId', 'roles'],
    properties: {
      id: uuid,
      email: { type: 'string' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      organisationId: uuid,
      roles: { type: 'array', items: { type: 'string' } },
      mustResetPassword: { type: 'boolean' },
      isPlatformAdmin: { type: 'boolean' },
    },
  },
  ContractNotification: {
    type: 'object',
    required: ['id', 'type', 'title', 'message', 'createdAt'],
    properties: { id: uuid, type: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, readAt: nullableDateTime, createdAt: dateTime },
  },
  ContractUnreadCount: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 0 } } },
  ContractShiftPresentation: {
    type: 'object',
    required: ['state', 'homeLabel', 'isToday', 'serverNow'],
    properties: {
      state: { type: 'string' },
      homeLabel: { type: 'string' },
      isToday: { type: 'boolean' },
      serverNow: dateTime,
      clockInAt: nullableDateTime,
      nextTransitionAt: nullableDateTime,
      closedReason: nullableString,
      canAccept: { type: 'boolean', nullable: true },
    },
  },
  ContractOfferSummary: {
    type: 'object',
    required: ['id', 'status', 'sentAt', 'expiresAt', 'estimatedPayPence', 'shiftId', 'startsAt', 'endsAt', 'venueName', 'roleName', 'staffProfileId', 'staffName', 'payRatePence'],
    properties: {
      id: uuid,
      status: { type: 'string' },
      sentAt: dateTime,
      expiresAt: dateTime,
      respondedAt: nullableDateTime,
      declineReason: nullableString,
      staffAcceptedAt: nullableDateTime,
      managerConfirmedAt: nullableDateTime,
      managerRejectedAt: nullableDateTime,
      rejectionReason: nullableString,
      estimatedPayPence: pence,
      shiftId: uuid,
      startsAt: dateTime,
      endsAt: dateTime,
      venueName: { type: 'string' },
      roleName: { type: 'string' },
      staffProfileId: uuid,
      staffName: { type: 'string' },
      payRatePence: pence,
      venueAddress: nullableString,
      shiftNotes: nullableString,
      venuePhotoFileId: nullableString,
      presentation: { allOf: [ref('ContractShiftPresentation')], nullable: true },
      checkInRequired: { type: 'boolean' },
      checkedInAt: nullableDateTime,
      checkInSource: nullableString,
      geofenceEnforced: { type: 'boolean', nullable: true },
      approvalDeadlineAt: nullableDateTime,
      awaitingManagerConfirmation: { type: 'boolean', nullable: true },
      closedReason: nullableString,
      canAccept: { type: 'boolean', nullable: true },
    },
  },
  ContractAttendanceSummary: {
    type: 'object',
    required: ['id', 'status', 'clockInAt', 'shiftId', 'startsAt', 'endsAt', 'venueName', 'roleName', 'staffProfileId', 'staffName'],
    properties: {
      id: uuid,
      status: { type: 'string' },
      clockInAt: dateTime,
      clockOutAt: nullableDateTime,
      workedMinutes: { type: 'integer', nullable: true },
      earnedPence: { type: 'integer', nullable: true },
      breakMinutes: { type: 'integer', nullable: true },
      locationVerified: { type: 'boolean', nullable: true },
      clockOutMethod: nullableString,
      shiftId: uuid,
      startsAt: dateTime,
      endsAt: dateTime,
      venueName: { type: 'string' },
      roleName: { type: 'string' },
      staffProfileId: uuid,
      staffName: { type: 'string' },
      venuePhotoFileId: nullableString,
      payrollStatus: nullableString,
      payrollApprovedPence: { type: 'integer', nullable: true },
      clockInMethod: nullableString,
      checkInRequired: { type: 'boolean', nullable: true },
      checkedInAt: nullableDateTime,
      checkInSource: nullableString,
    },
  },
  ContractActiveAttendance: {
    type: 'object',
    description: 'The running shift timer renders serverNow − clockInAt from this response, never device time.',
    required: ['attendance', 'serverNow'],
    properties: {
      attendance: { allOf: [ref('ContractAttendanceSummary')], nullable: true },
      serverNow: dateTime,
      clockInEarlyMinutes: { type: 'integer', minimum: 0 },
      locationEvidence: {
        type: 'object',
        required: ['maxAccuracyM', 'maxAgeSeconds', 'maxFutureSkewSeconds'],
        properties: { maxAccuracyM: { type: 'number' }, maxAgeSeconds: { type: 'number' }, maxFutureSkewSeconds: { type: 'number' } },
      },
    },
  },
  ContractPayslip: {
    type: 'object',
    required: ['period', 'payday', 'status'],
    properties: {
      payslipId: { ...uuid, nullable: true },
      runId: { ...uuid, nullable: true },
      period: { type: 'object', required: ['start', 'end'], properties: { id: uuid, start: date, end: date } },
      payday: date,
      status: { type: 'string', enum: ['upcoming', 'processing', 'available', 'paid'] },
      shiftCount: { type: 'integer', minimum: 0 },
      grossPence: pence,
      netPence: { ...pence, nullable: true },
      netSource: nullableString,
      document: {
        type: 'object',
        nullable: true,
        required: ['fileId'],
        properties: { fileId: uuid, filename: nullableString, version: { type: 'integer' }, uploadedAt: dateTime },
      },
      paidAt: nullableDateTime,
    },
  },
  ContractMyPayslips: {
    type: 'object',
    required: ['data', 'unallocated'],
    properties: {
      data: { type: 'array', items: ref('ContractPayslip') },
      unallocated: { type: 'object', required: ['shiftCount', 'grossPence'], properties: { shiftCount: { type: 'integer', minimum: 0 }, grossPence: pence } },
    },
  },
};

export interface ContractResponse {
  status: '200' | '201';
  description: string;
  schema: Schema;
}

/** `METHOD /path` (OpenAPI path syntax) → the response the clients rely on. */
export const CONTRACT_RESPONSES: Readonly<Record<string, ContractResponse>> = {
  'POST /rest/v1/auth/login': { status: '200', description: 'Signed in (no second factor pending).', schema: ref('ContractLoginResponse') },
  'GET /rest/v1/auth/me': { status: '200', description: 'The signed-in account.', schema: ref('ContractCurrentUser') },
  'GET /rest/v1/notifications': { status: '200', description: "The caller's notifications, newest first.", schema: { type: 'array', items: ref('ContractNotification') } },
  'GET /rest/v1/notifications/unread-count': { status: '200', description: 'Unread notifications of the caller.', schema: ref('ContractUnreadCount') },
  'GET /rest/v1/offers/mine': {
    status: '200',
    description: "The caller's offers and shifts. With `limit` or `cursor`: a keyset page; without: the bare array older installed apps read.",
    schema: { oneOf: [page('ContractOfferSummary'), { type: 'array', items: ref('ContractOfferSummary') }] },
  },
  'GET /rest/v1/attendance/me/active': { status: '200', description: "The caller's running attendance (or null) with the server clock.", schema: ref('ContractActiveAttendance') },
  'GET /rest/v1/attendance/me/history': {
    status: '200',
    description: "The caller's past attendance. With `limit` or `cursor`: a keyset page; without: the bare array older installed apps read.",
    schema: { oneOf: [page('ContractAttendanceSummary'), { type: 'array', items: ref('ContractAttendanceSummary') }] },
  },
  'GET /rest/v1/payroll/me/payslips': { status: '200', description: "The caller's official payslips, newest payday first.", schema: ref('ContractMyPayslips') },
};
