import { randomBytes } from 'node:crypto';

import { ForbiddenException, Injectable } from '@nestjs/common';

import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { PasswordHashingService } from './password-hashing.service';

/**
 * P2.8 — "sudo mode" for destructive platform-admin actions (grant/revoke
 * platform admin, delete a user). The caller's EXISTING session already
 * proves who they are; this proves they can still produce the password,
 * right now, for THIS specific call — a hijacked-but-live session (stolen
 * cookie/token) cannot alone perform the action. Deliberately NOT a time-
 * window/"logged in recently" check (no new session state to track, nothing
 * that could be reset by other activity) and NOT a second authentication
 * system — it reuses the exact `PasswordHashingService` primitive login
 * already uses.
 *
 * Timing/message-uniform with `AuthService.login()`'s own wrong-password
 * path (same file's own comment): an account with no password set (OAuth-
 * only) still runs one real argon2 verify against a dummy hash, so its
 * absence creates no observable timing signal that would tell a caller
 * "this account has no password" before they've proven they're its owner.
 *
 * Always throws (never returns a boolean a caller could forget to check).
 */
@Injectable()
export class StepUpReauthService {
  private dummyHashPromise?: Promise<string>;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
  ) {}

  private getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.passwordHashing.hash(randomBytes(32).toString('hex'));
    return this.dummyHashPromise;
  }

  /**
   * Reads via `core.auth_find_password_hash_by_user_id` — a SECURITY DEFINER function, never a
   * plain `manager.findOne(User, { select: ['passwordHash'] })`. `RevokeUserPasswordHashSelectFromApp
   * 1786669800000` deliberately revoked `rab_app`'s table-wide SELECT on `password_hash`; a raw
   * ORM read here would hit "permission denied for table user" in every real environment (confirmed
   * by running this exact code against a real Postgres connection — not a hypothetical). See
   * `AuthFindPasswordHashByUserId1786703000000`'s own doc comment for the full fix.
   */
  async assertCurrentPassword(ctx: Pick<AuthContext, 'organisationId' | 'workspaceId' | 'userId'>, currentPassword: string): Promise<void> {
    const hash = await this.tenantContext.runInTenantContext(
      { ...ctx, role: '' },
      async (manager) => {
        const [row] = await manager.query<Array<{ passwordHash: string | null }>>(
          'SELECT "passwordHash" FROM core.auth_find_password_hash_by_user_id($1)',
          [ctx.userId],
        );
        return row?.passwordHash ?? null;
      },
    );
    const valid = hash
      ? await this.passwordHashing.verify(hash, currentPassword)
      : await this.passwordHashing.verify(await this.getDummyHash(), currentPassword).then(() => false);
    if (!valid) throw new ForbiddenException('Re-enter your current password to continue.');
  }
}
