import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

export type OAuthProvider = 'google' | 'microsoft';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthTransaction {
  id: string;
  provider: OAuthProvider;
  codeVerifier: string;
  codeChallenge: string;
  nonce: string;
  returnToPath: string;
}

export interface ConsumedOAuthTransaction {
  pkceCodeVerifier: string;
  nonce: string;
  returnToPath: string | null;
}

/**
 * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.10, OAuthTransactionState1786680300000).
 * PostgreSQL-backed (no Redis this checkpoint — owner instruction, P1C.1B brief §3 Migration D),
 * server-held OAuth state for the Google/Microsoft LOGIN flow. Never inlines state into the
 * `state` query parameter the way Twenty's own login flow does (P1C.1A audit finding).
 */
@Injectable()
export class OAuthTransactionStateService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * `returnToPath` is validated here too (not only by the DB CHECK constraint) — must be a
   * same-origin relative path, never absolute/protocol-relative/javascript:/data: (P1C.1B brief
   * §18). Defaults safely to `/`.
   */
  private sanitiseReturnToPath(path: string | undefined): string {
    if (!path) return '/';
    if (!path.startsWith('/') || path.startsWith('//')) return '/';
    // Reject anything that could be interpreted as a scheme (e.g. "/\tjavascript:...", a classic
    // browser-normalisation trick) — a relative path never legitimately contains a colon before
    // its first slash-delimited segment ends, so this is a cheap, safe blanket reject.
    if (/^\/[^/]*:/i.test(path)) return '/';
    return path;
  }

  async create(provider: OAuthProvider, returnToPath?: string): Promise<OAuthTransaction> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const sanitisedReturnToPath = this.sanitiseReturnToPath(returnToPath);
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    const [row] = await this.dataSource.query<[{ id: string }]>(
      `INSERT INTO core.oauth_transaction_state (provider, pkce_code_verifier, nonce, return_to_path, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [provider, codeVerifier, nonce, sanitisedReturnToPath, expiresAt],
    );

    return { id: row!.id, provider, codeVerifier, codeChallenge, nonce, returnToPath: sanitisedReturnToPath };
  }

  /**
   * Atomic, one-time consumption. A replay (second consume attempt for the same id), a
   * provider mismatch, or an expired row all affect zero rows and are rejected identically —
   * never distinguished to the caller.
   */
  async consume(id: string, provider: OAuthProvider): Promise<ConsumedOAuthTransaction> {
    // TypeORM's raw `query()` returns a [rows, affectedCount] TUPLE for UPDATE/DELETE (unlike
    // SELECT/INSERT, which return the rows array directly) — same destructuring idiom already
    // established in this codebase for exactly this case (storage-reconcile.command.ts's
    // claimStalePending).
    const [rows] = await this.dataSource.query<[Array<{ pkce_code_verifier: string; nonce: string; return_to_path: string | null }>, number]>(
      `UPDATE core.oauth_transaction_state
          SET consumed_at = now()
        WHERE id = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING pkce_code_verifier, nonce, return_to_path`,
      [id, provider],
    );
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException('This sign-in attempt has expired or was already used. Please try again.');
    }
    return { pkceCodeVerifier: row.pkce_code_verifier, nonce: row.nonce, returnToPath: row.return_to_path };
  }
}
