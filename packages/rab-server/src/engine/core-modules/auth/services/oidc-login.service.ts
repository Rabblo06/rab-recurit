import { Injectable, UnauthorizedException } from '@nestjs/common';

import { EnvironmentService } from '../../environment/environment.service';
import { OAuthTransactionStateService, OAuthProvider } from './oauth-transaction-state.service';
import { OidcClientFactoryService, OidcProvider } from './oidc-client-factory.service';

export interface ProviderIdentity {
  subject: string;
  email: string;
}

const SCOPES: Record<OidcProvider, string> = {
  // Identity-only — openid/email/profile (Google), openid/email/profile (Microsoft's v2 /authorize
  // endpoint always returns an ID token with these claims for a 'User.Read'-equivalent sign-in;
  // no Mail.*/Calendars.* scope is ever requested here — that's the SEPARATE, not-built-this-
  // checkpoint Gmail/Calendar/Outlook integration path, kept deliberately distinct).
  google: 'openid email profile',
  microsoft: 'openid email profile',
};

/**
 * P1C.1B — the shared OIDC login flow both `GoogleAuthController` and `MicrosoftAuthController`
 * delegate to. Owns: building the authorization redirect URL (state/PKCE/nonce, server-held —
 * never inlined into the `state` parameter), and validating the callback (atomic one-time state
 * consumption, then the full openid-client `client.callback()` validation: authorization-code
 * exchange, PKCE verifier match, state match, nonce match, ID-token signature verification via
 * the provider's own JWKS, exp/iat/aud/azp checks — none of this is hand-rolled).
 *
 * Returns only a minimal, provider-agnostic `ProviderIdentity` — `AuthService.signInWithProvider`
 * is the one place that identity is resolved to a Crewflow user; this service knows nothing about
 * Crewflow accounts at all.
 */
@Injectable()
export class OidcLoginService {
  constructor(
    private readonly clients: OidcClientFactoryService,
    private readonly state: OAuthTransactionStateService,
    private readonly env: EnvironmentService,
  ) {}

  async buildAuthorizationUrl(provider: OAuthProvider, returnToPath?: string): Promise<string> {
    const client = await this.clients.getClient(provider);
    const tx = await this.state.create(provider, returnToPath);
    return client.authorizationUrl({
      scope: SCOPES[provider],
      state: tx.id,
      nonce: tx.nonce,
      code_challenge: tx.codeChallenge,
      code_challenge_method: 'S256',
      // Forces the account chooser every time — never a silent re-auth of whichever account
      // happens to have an active provider session in the browser (same hardening Twenty's own
      // Google/Microsoft guards apply, confirmed in the P1C.1A audit).
      prompt: 'select_account',
    });
  }

  async handleCallback(provider: OAuthProvider, callbackParams: Record<string, string | string[] | undefined>): Promise<{ identity: ProviderIdentity; returnToPath: string }> {
    const stateId = callbackParams.state;
    if (typeof stateId !== 'string' || !stateId) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
    // Atomic, one-time — throws on replay/expiry/provider-mismatch (OAuthTransactionStateService).
    const consumed = await this.state.consume(stateId, provider);

    const client = await this.clients.getClient(provider);
    const callbackUrl = provider === 'google' ? this.env.get('AUTH_GOOGLE_CALLBACK_URL') : this.env.get('AUTH_MICROSOFT_CALLBACK_URL');

    let tokenSet;
    try {
      tokenSet = await client.callback(callbackUrl, callbackParams, {
        state: stateId,
        nonce: consumed.nonce,
        code_verifier: consumed.pkceCodeVerifier,
      });
    } catch {
      // openid-client throws on ANY validation failure (code exchange, state/nonce/PKCE
      // mismatch, bad signature, expired token) — one generic outcome, never distinguished.
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }

    const claims = tokenSet.claims();
    const returnToPath = consumed.returnToPath ?? '/';

    if (provider === 'google') {
      // Google surfaces `email_verified` directly on the ID token — required, matching Twenty's
      // own correct check here (P1C.1A audit).
      if (!claims.email || claims.email_verified !== true) {
        throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
      }
      return { identity: { subject: claims.sub, email: claims.email }, returnToPath };
    }

    // Microsoft: durable identity is <tenantId>:<objectId> (`tid`:`oid`), never the bare `sub`
    // (which can be a per-client pairwise identifier depending on app configuration) and never
    // email/UPN (mutable, and not a safe durable key — P1C.1B brief §11). `oid`/`tid` are
    // Microsoft-specific extra claims openid-client passes through on the verified claims object
    // but doesn't type; both are REQUIRED here, not best-effort.
    const microsoftClaims = claims as typeof claims & { oid?: string; tid?: string; preferred_username?: string };
    if (!microsoftClaims.oid || !microsoftClaims.tid) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
    // SECURITY TRADE-OFF (documented, not silent — P1C.1B brief §11): Microsoft's v2 ID token
    // carries no `email_verified`-equivalent claim the way Google's does. First-link matching
    // for Microsoft therefore relies on (a) AUTH_MICROSOFT_TENANT='organizations' excluding
    // personal/unmanaged accounts, and (b) the receiving organisation's own Azure AD tenant
    // having already verified its members' corporate email addresses as a precondition of the
    // work account existing at all. Acceptable for a B2B platform whose Microsoft login targets
    // are managed corporate tenants; not a universal guarantee for every possible deployment.
    const email = microsoftClaims.email ?? microsoftClaims.preferred_username;
    if (!email) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
    return { identity: { subject: `${microsoftClaims.tid}:${microsoftClaims.oid}`, email }, returnToPath };
  }
}
