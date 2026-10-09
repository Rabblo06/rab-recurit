import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export type AuthProvider = 'google' | 'microsoft';

export interface LinkedIdentity {
  userId: string;
  organisationId: string;
}

/**
 * P1C.1B — durable Google/Microsoft provider-identity -> Crewflow-user mapping
 * (`core.user_auth_identity`, UserAuthIdentity1786680200000). See that migration's own doc
 * comment for the schema rationale; this service is its one write/read path.
 *
 * Never auto-creates a Crewflow user — that decision (invite-only signup preserved) is made by
 * `AuthService.signInWithProvider`, which is this service's only caller. This service's job is
 * narrower: resolve an already-linked identity, and atomically create a first-time link with a
 * race-safe re-check.
 */
@Injectable()
export class UserAuthIdentityService {
  constructor(private readonly dataSource: DataSource) {}

  /** Pre-auth — runs before any tenant context exists, via the SECURITY DEFINER lookup function. */
  async findLinkedUser(provider: AuthProvider, subject: string): Promise<LinkedIdentity | null> {
    const [row] = await this.dataSource.query<[{ userId: string; organisationId: string } | undefined]>(
      'SELECT * FROM core.auth_find_user_by_provider_identity($1, $2)',
      [provider, subject],
    );
    return row ?? null;
  }

  /**
   * Atomic, race-safe first-time link. `manager` must already be bound to the target user's own
   * tenant context (the INSERT policy requires `user_id = core.current_uid()`). Returns `true`
   * only if the identity now points at `userId` — a concurrent first-login racing for the SAME
   * provider identity is handled by `ON CONFLICT DO NOTHING` + a re-read; if some OTHER user won
   * the race (impossible under the UNIQUE constraint for the exact same subject, but checked
   * anyway per the owner's explicit instruction to fail closed rather than trust the happy path),
   * this returns `false` and the caller must refuse the sign-in.
   *
   * The bare `ON CONFLICT DO NOTHING` (no named target) deliberately covers BOTH unique
   * constraints on this table — `(provider, provider_subject)` (the race above) AND
   * `(user_id, provider)` (this user already has a DIFFERENT subject linked for this same
   * provider, e.g. they signed in with a different Google account previously) — a genuine
   * constraint violation on either must become this same calm "not linked to me" outcome, never
   * an unhandled 500 from a raw Postgres unique-violation error.
   */
  async linkFirstTime(
    manager: EntityManager,
    params: { organisationId: string; userId: string; provider: AuthProvider; subject: string; verifiedEmail: string },
  ): Promise<boolean> {
    await manager.query(
      `INSERT INTO core.user_auth_identity (organisation_id, user_id, provider, provider_subject, verified_email_snapshot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [params.organisationId, params.userId, params.provider, params.subject, params.verifiedEmail],
    );
    const [row] = await manager.query<[{ user_id: string } | undefined]>(
      'SELECT user_id FROM core.user_auth_identity WHERE provider = $1 AND provider_subject = $2',
      [params.provider, params.subject],
    );
    return row?.user_id === params.userId;
  }

  async touchLastUsed(manager: EntityManager, userId: string, provider: AuthProvider): Promise<void> {
    await manager.query('UPDATE core.user_auth_identity SET last_used_at = now() WHERE user_id = $1 AND provider = $2', [userId, provider]);
  }

  /** Thin wrapper so callers get a consistent, generic failure regardless of which internal reason caused it. */
  assertGenericFailure(): never {
    throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
  }
}
