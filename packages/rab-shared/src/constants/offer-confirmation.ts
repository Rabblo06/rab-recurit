/**
 * Manager-confirmation deadline (owner business rule, 2026-11-06). FROZEN INTERFACE CONTRACT shared by the server, the
 * Worker, rab-front and rab-mobile (Dart mirrors these literals). Change only after telling every stream.
 *
 * The rule:
 *  - The system NEVER confirms an offer. Only an authorised Internal Manager (the offer's sender holding
 *    `offer.confirm`) confirms, and only before the offer's approval deadline.
 *  - STANDARD offer: deadline = the individual assignment's start − MANAGER_CONFIRMATION_LEAD_MINUTES.
 *    REPLACEMENT / STANDBY offer: deadline = the end of its booked window (owner decision Q1b).
 *  - At the deadline a still-unconfirmed `staff_accepted` offer is withdrawn automatically: offer → `manager_rejected`
 *    (`rejected_by` NULL, `rejection_reason` = OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED), assignment →
 *    `rejected`. No attendance or payroll consequence; it can never be confirmed afterwards.
 *  - Every deadline is computed by PostgreSQL (`timestamptz − interval`, an absolute instant, so it is exactly 1,800 s
 *    before the start on BST/GMT change days too). Clients DISPLAY `approvalDeadlineAt`; they never compute it and never
 *    decide anything with a device clock.
 *
 * Not configurable on purpose: this is the owner's rule, not a tuning knob.
 */
export const MANAGER_CONFIRMATION_LEAD_MINUTES = 30;
export const MANAGER_CONFIRMATION_LEAD_MS =
  MANAGER_CONFIRMATION_LEAD_MINUTES * 60_000;

/**
 * Why an offer is closed, as projected to clients (`closedReason`). `null` = no special reason (or still open).
 *  - `confirmation_deadline_passed`: withdrawn at (or projected past) its approval deadline without a manager
 *    confirmation. The persisted marker is `job_offer.rejection_reason` with `rejected_by IS NULL`.
 *  - `shift_cancelled`: the shift itself was cancelled.
 */
export const OFFER_CLOSED_REASON = {
  CONFIRMATION_DEADLINE_PASSED: 'confirmation_deadline_passed',
  SHIFT_CANCELLED: 'shift_cancelled',
} as const;
export type OfferClosedReasonType =
  (typeof OFFER_CLOSED_REASON)[keyof typeof OFFER_CLOSED_REASON];

/** `body.code` of every 409 this rule produces (confirm, accept and send refusals). */
export const CONFIRMATION_DEADLINE_PASSED =
  'CONFIRMATION_DEADLINE_PASSED' as const;
export type ConfirmationDeadlineErrorCode = typeof CONFIRMATION_DEADLINE_PASSED;

/** `body.message` of those 409s (also the per-recipient `message` of bulk send / confirm-all results). */
export const CONFIRMATION_DEADLINE_MESSAGES = {
  /** POST /offers/:id/confirm (and confirm-all) on a STANDARD offer at or after its deadline. */
  CONFIRM:
    'The manager-confirmation deadline has passed, so this acceptance can no longer be confirmed.',
  /** The same for a REPLACEMENT / STANDBY offer whose booked window has ended. */
  CONFIRM_REPLACEMENT:
    'This shift has ended, so this replacement can no longer be confirmed.',
  /** POST /offers/:id/accept on a STANDARD offer at or after its deadline (the offer stays pending until it expires). */
  ACCEPT:
    'This shift starts too soon for a manager to confirm it, so it can no longer be accepted.',
  /** The same for a REPLACEMENT / STANDBY offer whose booked window has ended. */
  ACCEPT_REPLACEMENT:
    'This shift has ended, so this offer can no longer be accepted.',
  /**
   * POST /offers/:id/reject on an offer ALREADY withdrawn at its deadline (nothing changes). A reject after the deadline
   * but before the Worker has run is still accepted (a terminal, unconfirmed outcome either way).
   */
  REJECT:
    'The manager-confirmation deadline has passed, so this acceptance has already been withdrawn.',
  /** Any STANDARD send (new shift, send offers, VM-request approval, pipeline replace, replacement-request approval). */
  SEND: 'This shift starts in less than 30 minutes, so an offer could not be confirmed in time.',
} as const;

/** The JSON body of those 409s. */
export interface ConfirmationDeadlineErrorBody {
  statusCode: 409;
  code: ConfirmationDeadlineErrorCode;
  message: string;
}

/**
 * Notifications written exactly once per withdrawal (in the withdrawal's own transaction). Types are existing ones:
 * staff → `offer_rejected`; responsible manager and the venue's Venue Managers → `manager_confirmation_timeout`.
 * Bodies are the owner's exact text; titles were proposed and accepted subject to owner veto (Q13).
 */
export const CONFIRMATION_DEADLINE_NOTIFICATION = {
  STAFF: {
    type: 'offer_rejected',
    title: 'Shift offer withdrawn',
    message:
      'Your shift offer was withdrawn because final manager confirmation was not received before the approval deadline.',
  },
  MANAGER: {
    type: 'manager_confirmation_timeout',
    title: 'Confirmation deadline passed',
    message:
      'The manager-confirmation deadline has passed. The pending staff assignment has been withdrawn and may require replacement.',
  },
  VENUE_MANAGER: {
    type: 'manager_confirmation_timeout',
    title: 'Confirmation deadline passed',
    message:
      'The manager-confirmation deadline has passed. The pending staff assignment has been withdrawn and may require replacement.',
  },
} as const;

/** Display copy (owner decision Q7: the staff label is "Withdrawn"). */
export const CONFIRMATION_DEADLINE_LABELS = {
  /** Staff app chip / state label for `closedReason = confirmation_deadline_passed`. */
  STAFF_STATE: 'Withdrawn',
  /** Staff detail line. */
  STAFF_DETAIL: CONFIRMATION_DEADLINE_NOTIFICATION.STAFF.message,
  /** Manager / Venue Manager label for a withdrawn row. */
  MANAGER_STATE: 'Not confirmed in time',
  /** Web console status cell. */
  CONSOLE_DETAIL: 'Withdrawn — not confirmed before the approval deadline',
  /** Venue-offer pipeline `staff[].terminalSource` for a deadline withdrawal. */
  PIPELINE_TERMINAL_SOURCE: 'Not confirmed before the approval deadline',
} as const;

/** Timeline step key (`GET …/timeline` items[].step) for a deadline withdrawal (audit `offer.rejected_by_worker`). */
export const TIMELINE_STEP_OFFER_CONFIRMATION_DEADLINE =
  'offer_confirmation_deadline';

/**
 * Fields added to every offer projection (`GET /offers`, `GET /offers/mine`, `GET /offers/batches/:id` recipients) and to
 * every venue-offer pipeline `staff[]` row (`GET /shifts/:id/pipeline`). All computed in SQL with the database clock.
 * Dates are ISO-8601 UTC strings on the wire; booleans are never null.
 */
export interface OfferConfirmationDeadlineFields {
  /** STANDARD: assignment start − 30 min. REPLACEMENT / STANDBY: assignment end. */
  approvalDeadlineAt: string;
  /** status = staff_accepted AND database now < approvalDeadlineAt. */
  awaitingManagerConfirmation: boolean;
  /**
   * `confirmation_deadline_passed` when withdrawn at the deadline, OR (projection only, before the Worker has run) when
   * status is still staff_accepted and database now >= approvalDeadlineAt. `shift_cancelled` when the shift is cancelled.
   */
  closedReason: OfferClosedReasonType | null;
}

/** Manager reads only (`GET /offers`, `GET /offers/batches/:id`). Never present on `GET /offers/mine`. */
export interface ManagerOfferConfirmationFields extends OfferConfirmationDeadlineFields {
  /** awaitingManagerConfirmation AND the caller is the offer's sender (the same rule the confirm endpoint enforces). */
  canConfirm: boolean;
}

/**
 * Staff reads only (`GET /offers/mine`): on the row AND on its `presentation` object. Never present on manager reads.
 * Additive contract change (2026-11-06, after 6ee07bb3).
 */
export interface StaffOfferAcceptFields {
  /**
   * The offer could be accepted right now, judged by the server on the database clock: status pending, assignment still
   * offered, not expired (`expires_at`), shift not cancelled, and strictly before the approval deadline (STANDARD:
   * assignment start - 30 min; REPLACEMENT / STANDBY: assignment end). Display only: POST /offers/:id/accept stays the
   * authority and answers 409 (CONFIRMATION_DEADLINE_PASSED, or the existing expiry / already-responded errors).
   */
  canAccept: boolean;
}

/**
 * Added to the staff `presentation` object. `presentation.state` keeps its existing value set: a staff_accepted offer past
 * its deadline already presents as `rejected` (so old app builds show "Not confirmed", never "Awaiting").
 */
export interface StaffShiftPresentationConfirmationFields {
  closedReason: OfferClosedReasonType | null;
  /** Same value as the row's `canAccept` (`StaffOfferAcceptFields`); present on `GET /offers/mine` only. */
  canAccept?: boolean;
}

/** Added to the venue-offer pipeline `summary`. Rows stay in the `rejected` lane / `closed` group. */
export interface VenueOfferPipelineConfirmationSummary {
  withdrawnAtDeadline: number;
}
