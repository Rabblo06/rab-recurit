import { Injectable } from '@nestjs/common';

import { ProviderSignInIdentity } from './provider-sign-in.error';

export interface ProviderInvitationSummary {
  email: string;
  workspaceName: string | null;
  roleLabel: string;
}

/**
 * Accepting a member invitation with Google/Microsoft is owned by the staffing domain
 * (`modules/membership/MemberInvitationService`), but the OAuth flow lives in `engine/`, and `engine/` never imports
 * `modules/`. The membership module registers its implementation here at start-up; until it does, invitation
 * sign-ins fail closed.
 *
 * Every method re-validates from PostgreSQL (invitation live and unexpired, organisation and workspace active, the
 * provider's verified email equal to the invited email). `accept` additionally re-checks the inviter's authority
 * and the role, exactly like password acceptance, and creates ONLY the invited workspace member.
 */
export interface OAuthInvitationHandler {
  /** null ⇒ not acceptable by this identity (invalid, expired, revoked, or a different email). */
  describe(invitationTokenHash: string, identity: ProviderSignInIdentity): Promise<ProviderInvitationSummary | null>;
  /** Accepts the invitation as this provider identity; returns the new account's id. Throws on any failure. */
  accept(invitationTokenHash: string, provider: 'google' | 'microsoft', identity: ProviderSignInIdentity, clientIp: string): Promise<{ userId: string }>;
  /** SHA-256 of a raw invitation token (the same hash the invitation table stores). */
  hashToken(rawToken: string): string;
}

@Injectable()
export class OAuthInvitationHandlerRegistry {
  private handler: OAuthInvitationHandler | null = null;

  register(handler: OAuthInvitationHandler): void {
    this.handler = handler;
  }

  get(): OAuthInvitationHandler | null {
    return this.handler;
  }
}
