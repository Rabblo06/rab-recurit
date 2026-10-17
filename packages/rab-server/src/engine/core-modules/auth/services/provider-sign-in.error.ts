import { UnauthorizedException } from '@nestjs/common';

export const PROVIDER_SIGN_IN_GENERIC_MESSAGE = 'We could not sign you in. Try again or use another sign-in method.';

/** Internal reason for a refused Google/Microsoft sign-in — logged to the security log, never sent to the client. */
export type ProviderSignInFailureReason =
  | 'account_not_eligible'
  | 'email_not_verified_for_linking'
  | 'no_eligible_account'
  | 'ambiguous_accounts'
  | 'account_changed'
  | 'link_conflict'
  | 'invitation_invalid'
  | 'invitation_email_mismatch';

/** Always the same generic 401 to the caller; `reason` is for auditing only. */
export class ProviderSignInError extends UnauthorizedException {
  constructor(readonly reason: ProviderSignInFailureReason) {
    super(PROVIDER_SIGN_IN_GENERIC_MESSAGE);
  }
}

/** A provider identity whose ID token has been fully validated (see OidcLoginService.handleCallback). */
export interface ProviderSignInIdentity {
  subject: string;
  email: string;
  /** The provider proves control of `email` (Google `email_verified`, Microsoft `xms_edov`). Required for a first link. */
  emailVerified?: boolean;
  givenName?: string | null;
  familyName?: string | null;
}
