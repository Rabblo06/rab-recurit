import { Injectable, UnauthorizedException } from '@nestjs/common';

import { EnvironmentService } from '../../environment/environment.service';
import { ConsumedOAuthTransaction, OAuthIntent, OAuthReauthBinding, OAuthTransactionStateService, OAuthProvider } from './oauth-transaction-state.service';
import { OidcClientFactoryService, OidcProvider } from './oidc-client-factory.service';

export interface ProviderIdentity {
  subject: string;
  email: string;
  /**
   * Whether the provider PROVES control of `email`, which is what makes an email-based first link (or invitation
   * acceptance) safe. Google: `email_verified === true` (required — unverified Google emails are refused outright).
   * Microsoft: only the optional `xms_edov` ("email domain owner verified") claim proves it; without it a tenant
   * administrator anywhere can assert any address ("nOAuth"), so such an identity may sign in through an EXISTING
   * link but can never create one. Absent ⇒ false.
   */
  emailVerified?: boolean;
  givenName?: string | null;
  familyName?: string | null;
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

  /** Returns the provider URL plus the raw browser-binding secret the caller must set as `crewflow_oauth_tx`. */
  async buildAuthorizationUrl(
    provider: OAuthProvider,
    options: { returnToPath?: string; intent?: OAuthIntent; invitationTokenHash?: string; reauth?: OAuthReauthBinding } = {},
  ): Promise<{ url: string; browserSecret: string }> {
    const client = await this.clients.getClient(provider);
    const tx = await this.state.create(provider, options);
    const reauthenticate = options.intent === 'reauthenticate';
    const url = client.authorizationUrl({
      scope: SCOPES[provider],
      state: tx.id,
      nonce: tx.nonce,
      code_challenge: tx.codeChallenge,
      code_challenge_method: 'S256',
      ...(reauthenticate
        ? {
            // Account security step 1 (P6): FORCE a fresh credential entry. Microsoft identity platform documents
            // `prompt=login` ("forces the user to enter their credentials on that request, which negates single sign-on").
            // `max_age=0` is the OpenID Connect Core equivalent and makes `auth_time` REQUIRED in the ID token; the
            // callback refuses a missing or stale `auth_time` regardless (OidcReauthService), so a provider that ignores
            // either parameter fails closed instead of granting a step-up for an old login.
            prompt: 'login',
            max_age: 0,
          }
        : {
            // Forces the account chooser every time — never a silent re-auth of whichever account
            // happens to have an active provider session in the browser (same hardening Twenty's own
            // Google/Microsoft guards apply, confirmed in the P1C.1A audit).
            prompt: 'select_account',
          }),
    });
    return { url, browserSecret: tx.browserSecret };
  }

  async handleCallback(
    provider: OAuthProvider,
    callbackParams: Record<string, string | string[] | undefined>,
    browserSecret: string | undefined,
  ): Promise<{ identity: ProviderIdentity; returnToPath: string; transaction: ConsumedOAuthTransaction; authTime: number | null }> {
    const stateId = callbackParams.state;
    if (typeof stateId !== 'string' || !stateId) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
    // Atomic, one-time, browser-bound — throws on replay/expiry/provider-mismatch, or when this browser did not start
    // the sign-in (login CSRF / session swap) (OAuthTransactionStateService).
    const consumed = await this.state.consume(stateId, provider, browserSecret);

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
    // Validated, signed ID-token claim (seconds since epoch) — only the re-authentication flow relies on it.
    const authTime = typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time) ? claims.auth_time : null;
    const names = { givenName: typeof claims.given_name === 'string' ? claims.given_name : null, familyName: typeof claims.family_name === 'string' ? claims.family_name : null };

    if (provider === 'google') {
      // Google surfaces `email_verified` directly on the ID token — required, matching Twenty's
      // own correct check here (P1C.1A audit).
      if (!claims.email || claims.email_verified !== true) {
        throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
      }
      return { identity: { subject: claims.sub, email: claims.email, emailVerified: true, ...names }, returnToPath, transaction: consumed, authTime };
    }

    // Microsoft: durable identity is <tenantId>:<objectId> (`tid`:`oid`), never the bare `sub`
    // (which can be a per-client pairwise identifier depending on app configuration) and never
    // email/UPN (mutable, and not a safe durable key — P1C.1B brief §11). `oid`/`tid` are
    // Microsoft-specific extra claims openid-client passes through on the verified claims object
    // but doesn't type; both are REQUIRED here, not best-effort.
    const microsoftClaims = claims as typeof claims & { oid?: string; tid?: string; preferred_username?: string; xms_edov?: unknown };
    if (!microsoftClaims.oid || !microsoftClaims.tid) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
    // Microsoft's v2 ID token carries no `email_verified`. The earlier trade-off (trusting `email` /
    // `preferred_username` for first link because AUTH_MICROSOFT_TENANT='organizations') did not hold: the token can
    // come from ANY work tenant, whose administrator controls those values (the "nOAuth" class, audit finding F1).
    // Email-based first link now requires the optional `xms_edov` claim (configure it as an optional claim on the
    // app registration); an already-linked tid:oid keeps working without it.
    const email = microsoftClaims.email ?? microsoftClaims.preferred_username;
    if (!email) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
    // F1 (nOAuth): the email is only treated as proven when Microsoft says the domain owner verified it.
    const emailVerified = microsoftClaims.xms_edov === true || microsoftClaims.xms_edov === 'true' || microsoftClaims.xms_edov === 1;
    return { identity: { subject: `${microsoftClaims.tid}:${microsoftClaims.oid}`, email, emailVerified, ...names }, returnToPath, transaction: consumed, authTime };
  }
}
