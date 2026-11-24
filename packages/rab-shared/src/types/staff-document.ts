/**
 * Staff documents with an expiry (Lane D, milestone M1): right-to-work evidence, licences and certificates a staff member
 * holds. Stored in `core.staff_document` (StaffDocumentSchema1786722300000), one row per uploaded file.
 *
 * ASSUMPTION (flagged for the owner, compliance): the type list below is a starting set for UK hospitality staffing. Adding
 * a type is a migration (the table CHECK is a frozen literal) plus a value here.
 */
export const StaffDocumentType = {
  RIGHT_TO_WORK: 'right_to_work',
  PASSPORT: 'passport',
  VISA_OR_PERMIT: 'visa_or_permit',
  DBS_CHECK: 'dbs_check',
  SIA_LICENCE: 'sia_licence',
  PERSONAL_LICENCE: 'personal_licence',
  FOOD_HYGIENE: 'food_hygiene',
  FIRST_AID: 'first_aid',
  OTHER: 'other',
} as const;

export type StaffDocumentTypeType =
  (typeof StaffDocumentType)[keyof typeof StaffDocumentType];

export const STAFF_DOCUMENT_TYPES: readonly StaffDocumentTypeType[] =
  Object.freeze(Object.values(StaffDocumentType));

/** `other` is free-form evidence and can never be made a required type (the requirement CHECK excludes it too). */
export const REQUIRABLE_STAFF_DOCUMENT_TYPES: readonly StaffDocumentTypeType[] =
  Object.freeze(
    STAFF_DOCUMENT_TYPES.filter((t) => t !== StaffDocumentType.OTHER),
  );

export const STAFF_DOCUMENT_TYPE_LABELS: Readonly<
  Record<StaffDocumentTypeType, string>
> = Object.freeze({
  right_to_work: 'Right to work',
  passport: 'Passport',
  visa_or_permit: 'Visa or residence permit',
  dbs_check: 'DBS check',
  sia_licence: 'SIA licence',
  personal_licence: 'Personal licence',
  food_hygiene: 'Food hygiene certificate',
  first_aid: 'First aid certificate',
  other: 'Other document',
});

/**
 * Verification state of one document. Changed only through named actions (verify, reject, revoke), validated against
 * STAFF_DOCUMENT_TRANSITIONS, and again by the `core.staff_document_guard()` trigger in the database.
 */
export const StaffDocumentStatus = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
} as const;

export type StaffDocumentStatusType =
  (typeof StaffDocumentStatus)[keyof typeof StaffDocumentStatus];

/**
 * Virus-scan state. `clean` can only be recorded with the name of a real scanner engine (DB CHECK: scan evidence columns are
 * set exactly when the state is not `not_scanned`); with no scanner configured every upload stays `not_scanned`.
 * An `infected` upload is refused before it is stored; the value exists for a later asynchronous re-scan. A file is
 * HIDDEN (no download, no verification) until it is `clean` — the owner's recommended rule, still an OWNER DECISION.
 */
export const StaffDocumentScanStatus = {
  NOT_SCANNED: 'not_scanned',
  CLEAN: 'clean',
  INFECTED: 'infected',
} as const;

export type StaffDocumentScanStatusType =
  (typeof StaffDocumentScanStatus)[keyof typeof StaffDocumentScanStatus];

/**
 * Which types are REQUIRED when an organisation has not configured its own list (core.staff_document_requirement holds
 * per-organisation overrides; no row = this default). OWNER DECISION (recommended by the owner, answer pending): Right to
 * Work only.
 */
export const DEFAULT_REQUIRED_STAFF_DOCUMENT_TYPES: readonly StaffDocumentTypeType[] =
  Object.freeze([StaffDocumentType.RIGHT_TO_WORK]);

/**
 * Stable reason code a manager sees when an offer is refused because a REQUIRED document has expired. ASSUMPTION (flagged):
 * only an expired document blocks; a staff member with no document of a required type is not blocked (existing staff have
 * no uploaded documents yet, and the brief scopes the block to expiry).
 */
export const StaffDocumentOfferBlock = {
  REQUIRED_DOCUMENT_EXPIRED: 'STAFF_REQUIRED_DOCUMENT_EXPIRED',
} as const;

export type StaffDocumentOfferBlockType =
  (typeof StaffDocumentOfferBlock)[keyof typeof StaffDocumentOfferBlock];

/**
 * Days before `expires_on` (London date) at which the staff member and their managers are alerted; 0 = the expiry day
 * itself. ASSUMPTION (flagged): a document is valid up to and including its expiry date.
 */
export const STAFF_DOCUMENT_EXPIRY_ALERT_DAYS = Object.freeze([
  30, 7, 0,
] as const);
