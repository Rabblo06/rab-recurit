import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

import { OAUTH_HANDOFF_TTL_MS, OAUTH_TX_TTL_MS, isWellFormedOAuthSecret } from '../constants/oauth-cookies.constants';

export type OAuthProvider = 'google' | 'microsoft';
export type OAuthIntent = 'sign_in' | 'accept_invitation';

export interface OAuthTransaction {
  id: string;
  provider: OAuthProvider;
  codeVerifier: string;
  codeChallenge: string;
  nonce: string;
  returnToPath: string;
  /** Raw browser-binding secret for the `crewflow_oauth_tx` cookie; only its SHA-256 is stored. */
  browserSecret: string;
}

export interface ConsumedOAuthTransaction {
  id: string;
  pkceCodeVerifier: string;
  nonce: string;
  returnToPath: string | null;
  intent: OAuthIntent;
  invitationTokenHash: string | null;
}

export interface HandoffIdentity {
  subject: string;
  email: string;
  emailVerified?: boolean;
  givenName?: string | null;
  familyName?: string | null;
}

export interface RedeemedHandoff {
  transactionId: string;
  provider: OAuthProvider;
  intent: OAuthIntent;
  invitationTokenHash: string | null;
  returnToPath: string;
  identity: HandoffIdentity;
  resolvedUserId: string | null;
}

const GENERIC = 'We could not sign you in. Try again or use another sign-in method.';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Server-held state for one Google/Microsoft sign-in attempt (OAuthTransactionState1786680300000 +
 * OAuthBrowserBindingAndHandoff1786717000000). PostgreSQL is authoritative; nothing here is cached.
 *
 * Lifecycle of one row: `create` (start) → `consume` (callback; one-time, browser-bound) → `issueHandoff`
 * (callback validated) → `redeemHandoff` (web app completes sign-in; one-time). Every step is a single conditional
 * statement, so concurrent attempts — two callbacks, two redemptions, a replay — affect at most one row and the
 * losers fail with the same generic error. State, PKCE verifier and nonce are never inlined into the `state`
 * parameter (unlike Twenty's unsigned JSON state).
 */
@Injectable()
export class OAuthTransactionStateService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * `returnToPath` is validated here too (not only by the DB CHECK constraint) — must be a
   * same-origin relative path, never absolute/protocol-relative/javascript:/data: (P1C.1B brief
   * §18). Defaults safely to `/`.
   */
  sanitiseReturnToPath(path: string | undefined | null): string {
    if (!path || typeof path !== 'string' || path.length > 512) return '/';
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
    // Reject anything that could be interpreted as a scheme (e.g. "/\tjavascript:...", a classic
    // browser-normalisation trick) — a relative path never legitimately contains a colon before
    // its first slash-delimited segment ends, so this is a cheap, safe blanket reject.
    if (/^\/[^/]*:/i.test(path) || /[\u0000-\u001f\\]/.test(path)) return '/';
    return path;
  }

  async create(
    provider: OAuthProvider,
    options: { returnToPath?: string; intent?: OAuthIntent; invitationTokenHash?: string } = {},
  ): Promise<OAuthTransaction> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const browserSecret = randomBytes(32).toString('base64url');
    const returnToPath = this.sanitiseReturnToPath(options.returnToPath);
    const intent = options.intent ?? 'sign_in';
    const expiresAt = new Date(Date.now() + OAUTH_TX_TTL_MS);

    const [row] = await this.dataSource.query<[{ id: string }]>(
      `INSERT INTO core.oauth_transaction_state
         (provider, pkce_code_verifier, nonce, return_to_path, expires_at, browser_binding_hash, intent, invitation_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [provider, codeVerifier, nonce, returnToPath, expiresAt, sha256(browserSecret), intent, intent === 'accept_invitation' ? options.invitationTokenHash : null],
    );

    return { id: row!.id, provider, codeVerifier, codeChallenge, nonce, returnToPath, browserSecret };
  }

  /**
   * Atomic, one-time, browser-bound consumption. A replay, a provider mismatch, an expired row, or a browser that
   * does not hold the start cookie all affect zero rows and are rejected identically — never distinguished.
   */
  async consume(id: string, provider: OAuthProvider, browserSecret: string | undefined): Promise<ConsumedOAuthTransaction> {
    if (!isWellFormedOAuthSecret(browserSecret) || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new UnauthorizedException('This sign-in attempt has expired or was already used. Please try again.');
    }
    // TypeORM's raw `query()` returns a [rows, affectedCount] TUPLE for UPDATE/DELETE.
    const [rows] = await this.dataSource.query<
      [Array<{ id: string; pkce_code_verifier: string; nonce: string; return_to_path: string | null; intent: OAuthIntent; invitation_token_hash: string | null }>, number]
    >(
      `UPDATE core.oauth_transaction_state
          SET consumed_at = now()
        WHERE id = $1 AND provider = $2 AND browser_binding_hash = $3 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, pkce_code_verifier, nonce, return_to_path, intent, invitation_token_hash`,
      [id, provider, sha256(browserSecret)],
    );
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException('This sign-in attempt has expired or was already used. Please try again.');
    }
    return {
      id: row.id,
      pkceCodeVerifier: row.pkce_code_verifier,
      nonce: row.nonce,
      returnToPath: row.return_to_path,
      intent: row.intent,
      invitationTokenHash: row.invitation_token_hash,
    };
  }

  /** After a validated callback: attach the identity and issue the one-time handoff secret (returned raw once). */
  async issueHandoff(transactionId: string, identity: HandoffIdentity, resolvedUserId: string | null): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    const [rows] = await this.dataSource.query<[Array<{ id: string }>, number]>(
      `UPDATE core.oauth_transaction_state
          SET authenticated_at = now(), handoff_token_hash = $2, handoff_expires_at = now() + ($3::text || ' milliseconds')::interval,
              provider_subject = $4, provider_email = $5, provider_given_name = $6, provider_family_name = $7, resolved_user_id = $8,
              provider_email_verified = $9
        WHERE id = $1 AND consumed_at IS NOT NULL AND authenticated_at IS NULL
        RETURNING id`,
      [
        transactionId,
        sha256(secret),
        String(OAUTH_HANDOFF_TTL_MS),
        identity.subject,
        identity.email,
        identity.givenName?.slice(0, 200) ?? null,
        identity.familyName?.slice(0, 200) ?? null,
        resolvedUserId,
        identity.emailVerified === true,
      ],
    );
    if (!rows[0]) throw new UnauthorizedException(GENERIC);
    return secret;
  }

  /** Read-only view of a live handoff (for the confirmation screen). Never consumes it. */
  async peekHandoff(secret: string | undefined): Promise<Omit<RedeemedHandoff, 'transactionId'> | null> {
    if (!isWellFormedOAuthSecret(secret)) return null;
    const [row] = await this.dataSource.query<HandoffRow[]>(
      `SELECT id, provider, intent, invitation_token_hash, return_to_path, provider_subject, provider_email, provider_email_verified, provider_given_name,
              provider_family_name, resolved_user_id
         FROM core.oauth_transaction_state
        WHERE handoff_token_hash = $1 AND handoff_consumed_at IS NULL AND handoff_expires_at > now()`,
      [sha256(secret)],
    );
    if (!row) return null;
    const { transactionId: _id, ...rest } = toRedeemed(row, this.sanitiseReturnToPath(row.return_to_path));
    return rest;
  }

  /**
   * Atomic single use: the row is locked, re-checked (unconsumed, unexpired) and marked consumed in ONE statement;
   * the provider identity is erased from the row in the same statement. A concurrent second redemption re-evaluates
   * the locked row, finds it consumed, and gets nothing.
   */
  async redeemHandoff(secret: string | undefined): Promise<RedeemedHandoff> {
    if (!isWellFormedOAuthSecret(secret)) throw new UnauthorizedException(GENERIC);
    const [rows] = await this.dataSource.query<[HandoffRow[], number]>(
      `UPDATE core.oauth_transaction_state t
          SET handoff_consumed_at = now(), provider_subject = NULL, provider_email = NULL,
              provider_given_name = NULL, provider_family_name = NULL
         FROM (SELECT id, provider, intent, invitation_token_hash, return_to_path, provider_subject, provider_email,
                      provider_email_verified, provider_given_name, provider_family_name, resolved_user_id
                 FROM core.oauth_transaction_state WHERE handoff_token_hash = $1) old
        WHERE t.id = old.id AND t.handoff_token_hash = $1 AND t.handoff_consumed_at IS NULL AND t.handoff_expires_at > now()
       RETURNING old.*`,
      [sha256(secret)],
    );
    const row = rows[0];
    if (!row || !row.provider_subject || !row.provider_email) throw new UnauthorizedException(GENERIC);
    return toRedeemed(row, this.sanitiseReturnToPath(row.return_to_path));
  }
}

interface HandoffRow {
  id: string;
  provider: OAuthProvider;
  intent: OAuthIntent;
  invitation_token_hash: string | null;
  return_to_path: string | null;
  provider_subject: string | null;
  provider_email: string | null;
  provider_email_verified: boolean;
  provider_given_name: string | null;
  provider_family_name: string | null;
  resolved_user_id: string | null;
}

function toRedeemed(row: HandoffRow, returnToPath: string): RedeemedHandoff {
  return {
    transactionId: row.id,
    provider: row.provider,
    intent: row.intent,
    invitationTokenHash: row.invitation_token_hash,
    returnToPath,
    identity: { subject: row.provider_subject ?? '', email: row.provider_email ?? '', emailVerified: row.provider_email_verified === true, givenName: row.provider_given_name, familyName: row.provider_family_name },
    resolvedUserId: row.resolved_user_id,
  };
}
