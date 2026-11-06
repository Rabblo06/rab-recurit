import {
  CONFIRMATION_DEADLINE_LABELS,
  CONFIRMATION_DEADLINE_MESSAGES,
  CONFIRMATION_DEADLINE_PASSED,
  OFFER_CLOSED_REASON,
} from '@rab/shared';
import { getApiErrorCode, normalizeApiError } from './apiError';

/**
 * Manager-confirmation deadline (owner rule 2026-11-06): the system never confirms an offer; an accepted offer the
 * sending manager has not confirmed by its approval deadline is withdrawn by the server. Used by the offers, scheduling
 * and dashboard features.
 *
 * The SERVER decides everything here. `approvalDeadlineAt`, `awaitingManagerConfirmation`, `closedReason` and
 * `canConfirm` are computed in SQL with the database clock (`@rab/shared` offer-confirmation.ts). This module only
 * displays them. It never computes a deadline and never compares anything with the device clock. When an older API
 * does not send the fields yet, the console keeps today's behaviour (Confirm on `staff_accepted`), and the server's
 * 409 CONFIRMATION_DEADLINE_PASSED stays the authority either way.
 */
export interface OfferConfirmationFields {
  status?: string;
  /** ISO-8601. STANDARD offer: assignment start − 30 min. REPLACEMENT / STANDBY: end of the booked window. */
  approvalDeadlineAt?: string | null;
  awaitingManagerConfirmation?: boolean;
  closedReason?: string | null;
  /** Manager reads only: awaiting confirmation AND the caller sent the offer. */
  canConfirm?: boolean;
}

/** Withdrawn (or, before the Worker has run, projected as withdrawn) because no manager confirmed it in time. */
export function isWithdrawnAtDeadline(offer: Pick<OfferConfirmationFields, 'closedReason'>): boolean {
  return offer.closedReason === OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED;
}

/**
 * Whether the console may offer Confirm / Reject for this offer. Only a `staff_accepted` offer, and never when the
 * server says it is closed, no longer awaiting confirmation, or not the caller's to confirm. A field the server does
 * not send is unknown and changes nothing.
 */
export function mayDecideAcceptedOffer(offer: OfferConfirmationFields): boolean {
  if (offer.status !== 'staff_accepted') return false;
  if (offer.closedReason != null) return false;
  if (offer.awaitingManagerConfirmation === false) return false;
  if (offer.canConfirm === false) return false;
  return true;
}

const DEADLINE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** "Fri 6 Nov, 18:30 GMT": the server's deadline in the viewer's local time, with its time zone. Null when unknown. */
export function formatApprovalDeadline(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return DEADLINE_FORMAT.format(at);
}

/** "Confirm by Fri 6 Nov, 18:30 GMT", or null when the server sent no deadline. */
export function confirmByLabel(iso: string | null | undefined): string | null {
  const when = formatApprovalDeadline(iso);
  return when ? `Confirm by ${when}` : null;
}

/** The server refused because the approval deadline has passed (409 `CONFIRMATION_DEADLINE_PASSED`). */
export function isConfirmationDeadlineError(error: unknown): boolean {
  return getApiErrorCode(error) === CONFIRMATION_DEADLINE_PASSED;
}

/** The server's own text for that refusal when it is safe to show, else the contract's text for the action. */
export function confirmationDeadlineMessage(
  error: unknown,
  fallback: string = CONFIRMATION_DEADLINE_MESSAGES.CONFIRM,
): string {
  return normalizeApiError(error).serverMessage ?? fallback;
}

export const NOT_CONFIRMED_IN_TIME = CONFIRMATION_DEADLINE_LABELS.MANAGER_STATE;
export const WITHDRAWN_AT_DEADLINE_DETAIL = CONFIRMATION_DEADLINE_LABELS.CONSOLE_DETAIL;
export const PIPELINE_DEADLINE_SOURCE = CONFIRMATION_DEADLINE_LABELS.PIPELINE_TERMINAL_SOURCE;
