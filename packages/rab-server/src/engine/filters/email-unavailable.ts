/**
 * The one representation of "this email address already belongs to an account in another organisation" (owner policy 2026-10-15,
 * enforced by the `user_email_unique_across_organisations` trigger — `EmailUniqueAcrossOrganisationsForNewAccounts1786717400000`).
 *
 * Deliberately generic: it never says which organisation holds the address, nor that account's role, status or workspace.
 */
export const EMAIL_UNAVAILABLE_CONSTRAINT = 'user_email_registered_in_another_organisation';
export const EMAIL_UNAVAILABLE_CODE = 'EMAIL_UNAVAILABLE';
export const EMAIL_UNAVAILABLE_MESSAGE = 'This email address can’t be used for a new Crewflow account. Use a different email address.';

/** True for the trigger's unique violation, whether TypeORM surfaces it on the error itself or on `driverError`. */
export function isEmailUnavailableViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const constraint = candidate.constraint ?? candidate.driverError?.constraint;
  return constraint === EMAIL_UNAVAILABLE_CONSTRAINT;
}
